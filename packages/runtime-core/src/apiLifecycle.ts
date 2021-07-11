import {
  ComponentInternalInstance,
  currentInstance,
  isInSSRComponentSetup,
  LifecycleHooks,
  setCurrentInstance
} from './component'
import { ComponentPublicInstance } from './componentPublicInstance'
import { callWithAsyncErrorHandling, ErrorTypeStrings } from './errorHandling'
import { warn } from './warning'
import { toHandlerKey } from '@vue/shared'
import { DebuggerEvent, pauseTracking, resetTracking } from '@vue/reactivity'

export { onActivated, onDeactivated } from './components/KeepAlive'

/**
 * 对注册的hook做一层封装
 * 1. 生命周期注册
 * 2. 生命周期执行
 */
export function injectHook(
  type: LifecycleHooks,
  hook: Function & { __weh?: Function },
  target: ComponentInternalInstance | null = currentInstance,
  prepend: boolean = false
): Function | undefined {
  if (target) {
    /**
     * 封装hook钩子函数并缓存
     */
    const hooks = target[type] || (target[type] = [])
    /**
     * 对于相同的钩子函数，会缓存到_weh中，后续通过schedule的方式去重
     */
    // cache the error handling wrapper for injected hooks so the same hook
    // can be properly deduped by the scheduler. "__weh" stands for "with error
    // handling".
    const wrappedHook =
      hook.__weh ||
      (hook.__weh = (...args: unknown[]) => {
        if (target.isUnmounted) {
          return
        }
        /**
         * 停止依赖收集
         */
        // disable tracking inside all lifecycle hooks
        // since they can potentially be called inside effects.
        pauseTracking()
        /**
         * 设置target为当前运行的组件的实例
         * 为了确保此时currentInstance和注册钩子实例保持一致
         */
        // Set currentInstance during hook invocation.
        // This assumes the hook does not synchronously trigger other hooks, which
        // can only be false when the user does something really funky.
        setCurrentInstance(target)
        /**
         * 执行钩子函数
         */
        const res = callWithAsyncErrorHandling(hook, target, type, args)
        setCurrentInstance(null)
        /**
         * 恢复依赖收集
         */
        resetTracking()
        return res
      })
    if (prepend) {
      hooks.unshift(wrappedHook)
    } else {
      hooks.push(wrappedHook)
    }
    return wrappedHook
  } else if (__DEV__) {
    const apiName = toHandlerKey(ErrorTypeStrings[type].replace(/ hook$/, ''))
    warn(
      `${apiName} is called when there is no active component instance to be ` +
        `associated with. ` +
        `Lifecycle injection APIs can only be used during execution of setup().` +
        (__FEATURE_SUSPENSE__
          ? ` If you are using async setup(), make sure to register lifecycle ` +
            `hooks before the first await statement.`
          : ``)
    )
  }
}
/**
 * 创建生命周期钩子
 * 返回injectHook函数,函数逻辑类似，唯一区别是第一个字符串不同(函数柯里化技巧,使函数参保留)
 * 不使用柯里化版本：
 *  cosnt onBeforeMount = function(hook, target = currentInstance) {
 *    injectHook('bm', hook, target)
 *  }
 */
export const createHook = <T extends Function = () => any>(
  lifecycle: LifecycleHooks
) => (hook: T, target: ComponentInternalInstance | null = currentInstance) =>
  // post-create lifecycle registrations are noops during SSR (except for serverPrefetch)
  (!isInSSRComponentSetup || lifecycle === LifecycleHooks.SERVER_PREFETCH) &&
  injectHook(lifecycle, hook, target)

export const onBeforeMount = createHook(LifecycleHooks.BEFORE_MOUNT)
export const onMounted = createHook(LifecycleHooks.MOUNTED)
export const onBeforeUpdate = createHook(LifecycleHooks.BEFORE_UPDATE)
export const onUpdated = createHook(LifecycleHooks.UPDATED)
export const onBeforeUnmount = createHook(LifecycleHooks.BEFORE_UNMOUNT)
export const onUnmounted = createHook(LifecycleHooks.UNMOUNTED)
export const onServerPrefetch = createHook(LifecycleHooks.SERVER_PREFETCH)

export type DebuggerHook = (e: DebuggerEvent) => void
export const onRenderTriggered = createHook<DebuggerHook>(
  LifecycleHooks.RENDER_TRIGGERED
)
export const onRenderTracked = createHook<DebuggerHook>(
  LifecycleHooks.RENDER_TRACKED
)

export type ErrorCapturedHook<TError = unknown> = (
  err: TError,
  instance: ComponentPublicInstance | null,
  info: string
) => boolean | void

export function onErrorCaptured<TError = Error>(
  hook: ErrorCapturedHook<TError>,
  target: ComponentInternalInstance | null = currentInstance
) {
  injectHook(LifecycleHooks.ERROR_CAPTURED, hook, target)
}
