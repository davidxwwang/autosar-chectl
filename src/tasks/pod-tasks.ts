/**
 * Copyright (c) 2019-2021 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { cli } from 'cli-ux'
import * as Listr from 'listr'
import {KubeClient} from '../api/kube-client'
import {KubeHelperContext} from '../context'
import {EclipseChe} from './installers/eclipse-che/eclipse-che'
import {newListr} from '../utils/utls'

export namespace PodTasks {
  interface FailState {
    reason?: string
    message?: string
  }

  const INTERVAL = 500

  export function getDeploymentExistanceTask(deploymentName: string, namespace: string): Listr.ListrTask<any> {
    return {
      title: `Checking if deployment ${deploymentName} exists`,
      task: async (ctx: any, task: any) => {
        const kubeClient = KubeClient.getInstance()

        const exists = await kubeClient.isDeploymentExist(deploymentName, namespace)
        if (!exists) {
          cli.error(`Deployment ${deploymentName} not found.`)
        }

        task.title = `${task.title}...[Found]`
      },
    }
  }

  export function getWaitLatestReplicaTask(deploymentName: string, namespace: string): Listr.ListrTask<any> {
    return {
      title: `Wait for ${deploymentName} latest replica`,
      task: async (_ctx: any, task: any) => {
        const kubeClient = KubeClient.getInstance()
        await cli.wait(1000)
        await kubeClient.waitLatestReplica(deploymentName, namespace)
        task.title = `${task.title}...[OK]`
      },
    }
  }

  export function getScaleDeploymentTask(name: string, deploymentName: string, replicas: number, namespace: string): Listr.ListrTask<any> {
    const kubeHelper = KubeClient.getInstance()
    return {
      title: `Scale ${name} ${replicas > 0 ? 'Up' : 'Down'}`,
      task: async (_ctx: any, task: any) => {
        await kubeHelper.scaleDeployment(deploymentName, namespace, replicas)
        task.title = `${task.title}...[OK]`
      },
    }
  }

  export function getPodDeletedTask(name: string, selector: string, namespace: string): Listr.ListrTask<any> {
    const kubeHelper = KubeClient.getInstance()
    return {
      title: `${name} pod`,
      task: async (_ctx: any, task: any) => {
        await kubeHelper.waitUntilPodIsDeleted(selector, namespace)
        task.title = `${task.title}...[Deleted]`
      },
    }
  }

  export function getPodStartTasks(name: string, selector: string, namespace: string): Listr.ListrTask<any> {
    return {
      title: `${name} pod bootstrap`,
      task: async (_ctx: any, _task: any) => {
        const tasks = newListr([])
        tasks.add(getSchedulingTask(selector, namespace))
        tasks.add(getDownloadingTask(selector, namespace))
        tasks.add(getStartingTask(selector, namespace))
        return tasks
      },
    }

    function getSchedulingTask(selector: string, namespace: string): Listr.ListrTask<any> {
      return {
        title: 'Scheduling',
        task: async (ctx: any, task: any) => {
          const iterations = ctx[KubeHelperContext.POD_WAIT_TIMEOUT] / INTERVAL
          for (let i = 1; i <= iterations; i++) {
            // check cheCluster status
            const cheClusterFailState = await getCheClusterFailState(namespace)
            // check 'PodScheduled' condition
            const podFailState = await getPodFailState(namespace, selector, 'PodScheduled')

            if (cheClusterFailState || podFailState) {
              const iterations = ctx[KubeHelperContext.POD_ERROR_RECHECK_TIMEOUT] / 1000
              let cheClusterFailState: FailState | undefined
              let podFailState: FailState | undefined

              for (let j = 0; j < iterations; j++) {
                await cli.wait(1000)

                cheClusterFailState = await getCheClusterFailState(namespace)
                podFailState = await getPodFailState(namespace, selector, 'PodScheduled')

                if (!cheClusterFailState && !podFailState) {
                  break
                }
              }

              if (cheClusterFailState) {
                throw new Error(`${EclipseChe.PRODUCT_NAME} operator failed, reason: ${cheClusterFailState.reason}, message: ${cheClusterFailState.message}. Consider increasing error recheck timeout with --k8spoderrorrechecktimeout flag.`)
              }

              if (podFailState) {
                throw new Error(`Failed to schedule a pod, reason: ${podFailState.reason}, message: ${podFailState.message}. Consider increasing error recheck timeout with --k8spoderrorrechecktimeout flag.`)
              }
            }

            const allScheduled = await isPodConditionStatusPassed(namespace, selector, 'PodScheduled')
            if (allScheduled) {
              task.title = `${task.title}...[OK]`
              return
            }

            await cli.wait(INTERVAL)
          }

          throw new Error(`Failed to schedule a pod: ${await getTimeOutErrorMessage(namespace, selector)}`)
        },
      }
    }

    function getDownloadingTask(selector: string, namespace: string): Listr.ListrTask<any> {
      const kubeHelper = KubeClient.getInstance()

      return {
        title: 'Downloading images',
        task: async (ctx: any, task: any) => {
          const iterations = ctx[KubeHelperContext.POD_DOWNLOAD_IMAGE_TIMEOUT] / INTERVAL
          for (let i = 1; i <= iterations; i++) {
            const failedState = await getContainerFailState(namespace, selector, 'Pending')
            if (failedState) {
              const iterations = ctx[KubeHelperContext.POD_ERROR_RECHECK_TIMEOUT] / 1000
              let failedState: FailState | undefined

              for (let j = 0; j < iterations; j++) {
                await cli.wait(1000)

                failedState = await getContainerFailState(namespace, selector, 'Pending')

                if (!failedState) {
                  break
                }
              }

              if (failedState) {
                throw new Error(`Failed to download image, reason: ${failedState.reason}, message: ${failedState.message}.`)
              }
            }

            const pods = await kubeHelper.getPodListByLabel(namespace, selector)
            const allRunning = !pods.some(value => !value.status || value.status.phase !== 'Running')
            if (pods.length && allRunning) {
              task.title = `${task.title}...[OK]`
              return
            }

            await cli.wait(INTERVAL)
          }

          throw new Error(`Failed to download image: ${await getTimeOutErrorMessage(namespace, selector)}`)
        },
      }
    }

    function getStartingTask(selector: string, namespace: string): Listr.ListrTask<any> {
      const kubeHelper = KubeClient.getInstance()

      return {
        title: 'Starting',
        task: async (ctx: any, task: any) => {
          const iterations = ctx[KubeHelperContext.POD_READY_TIMEOUT] / INTERVAL
          for (let i = 1; i <= iterations; i++) {
            // check cheCluster status
            const cheClusterFailState = await getCheClusterFailState(namespace)
            const failedState = await getContainerFailState(namespace, selector, 'Running')
            if (cheClusterFailState || failedState) {
              const iterations = ctx[KubeHelperContext.POD_ERROR_RECHECK_TIMEOUT] / 1000
              let cheClusterFailState: FailState | undefined
              let failedState: FailState | undefined

              for (let j = 0; j < iterations; j++) {
                await cli.wait(1000)

                cheClusterFailState = await getCheClusterFailState(namespace)
                failedState = await getContainerFailState(namespace, selector, 'Running')

                if (!cheClusterFailState && !failedState) {
                  break
                }
              }

              if (cheClusterFailState) {
                throw new Error(`${EclipseChe.PRODUCT_NAME} operator failed, reason: ${cheClusterFailState.reason}, message: ${cheClusterFailState.message}. Consider increasing error recheck timeout with --k8spoderrorrechecktimeout flag.`)
              }

              if (failedState) {
                throw new Error(`Failed to start a pod, reason: ${failedState.reason}, message: ${failedState.message}`)
              }
            }

            const terminatedState = await kubeHelper.getPodLastTerminatedState(namespace, selector)
            if (terminatedState) {
              let errorMsg = `Failed to start a pod, reason: ${terminatedState.reason}`
              terminatedState.message && (errorMsg += `, message: ${terminatedState.message}`)
              terminatedState.exitCode && (errorMsg += `, exitCode: ${terminatedState.exitCode}`)
              terminatedState.signal && (errorMsg += `, signal: ${terminatedState.signal}`)
              throw new Error(errorMsg)
            }

            const allStarted = await isPodConditionStatusPassed(namespace, selector, 'Ready')
            if (allStarted) {
              task.title = `${task.title}...[OK]`
              return
            }

            await cli.wait(INTERVAL)
          }

          throw new Error(`Failed to start a pod: ${await getTimeOutErrorMessage(namespace, selector)}`)
        },
      }
    }
  }

  async function getPodFailState(namespace: string, selector: string, conditionType: string): Promise<FailState | undefined> {
    const kubeHelper = KubeClient.getInstance()
    const status = await kubeHelper.getPodCondition(namespace, selector, conditionType)
    return status.find(s => s.status === 'False' && s.message && s.reason)
  }

  async function isPodConditionStatusPassed(namespace: string, selector: string, conditionType: string): Promise<boolean> {
    const kubeHelper = KubeClient.getInstance()
    const status = await kubeHelper.getPodCondition(namespace, selector, conditionType)
    const allScheduled = !status.some(s => s.status !== 'True')
    return Boolean(status.length) && allScheduled
  }

  /**
  * Checks if there is any reason for a given pod state and returns message if so.
  */
  async function getContainerFailState(namespace: string, selector: string, state: string): Promise<FailState | undefined> {
    const kubeHelper = KubeClient.getInstance()
    const waitingState = await kubeHelper.getPodWaitingState(namespace, selector, state)
    if (waitingState && waitingState.reason && waitingState.message) {
      return waitingState
    }
  }

  /**
   * Returns extended timeout error message explaining a failure.
   */
   async function getTimeOutErrorMessage(namespace: string, selector: string): Promise<string> {
     const kubeHelper = KubeClient.getInstance()
     const pods = await kubeHelper.getPodListByLabel(namespace, selector)
     if (!pods.length) {
       throw new Error(`Timeout: there are no pods in the namespace: ${namespace}, selector: ${selector}. Check ${EclipseChe.PRODUCT_NAME} logs for details. Consider increasing error recheck timeout with --k8spoderrorrechecktimeout flag.`)
     }

     let errorMessage = 'Timeout:'
     for (const pod of pods) {
       errorMessage += `\nPod: ${pod.metadata!.name}`
       if (pod.status) {
         if (pod.status.containerStatuses) {
           errorMessage += `\n\t\tstatus: ${JSON.stringify(pod.status.containerStatuses, undefined, '  ')}`
         }
         if (pod.status.conditions) {
           errorMessage += `\n\t\tconditions: ${JSON.stringify(pod.status.conditions, undefined, '  ')}`
         }
       } else {
         errorMessage += ', status not found.'
       }
     }

     return errorMessage
   }

   async function getCheClusterFailState(namespace: string): Promise<FailState | undefined> {
     const kubeHelper = KubeClient.getInstance()
     const cheCluster = await kubeHelper.getCheCluster(namespace)
     if (cheCluster?.status?.reason && cheCluster?.status?.message) {
       return cheCluster.status
     }
   }
}

