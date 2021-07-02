import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'
/**
 * Note:
 *
 * 1. effect: 响应式的核心， 会在 mountComponent, doWatch, reactive, computed 时调用
 * 2. 调effect -> track跟踪 -> 存 targetMap
 * 3. 执行reactive -> Proxy 劫持， getter 执行 track;  setter 执行 trigger
 * 4. 劫持的对象存 targetMap的 weakMap中
 *   1） 结构： targetMap<WeakMap> -> target<Map> -> key<Set>
 *   2） 当前effect -> activeEffect 放在 key<Set>中
 *   3） targetMap<WeakMap> -> target<Map> -> key<Set>
 */

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
  allowRecurse: boolean
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
  /**
   * Indicates whether the job is allowed to recursively trigger itself when
   * managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

/**
 * 标记是否被effect过
 */
export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

/**
 * 在 watch， trigger, computed, mountComponent中调用
 */
export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) {
    /**
     * 第一次不会走这段代码，第二次执行时， fn其实就是~
     * 坑： 函数名 和变量使用同一个名称 (内部的effect是一个私有变量，不会改变外部的effect函数)
     */
    fn = fn.raw
  }
  const effect = createReactiveEffect(fn, options)
  if (!options.lazy) {
    /**
     * computed就是一个lazy effect, 当遇到lazy时，就不执行effect()
     * 因为 effect = createReactiveEffect（fn, option）, 所以执行effect（）实际就是执行 run(effect,fn, args)
     */
    effect()
  }
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

/**
 * 执行 createReactiveEffect 后得到的是一个 function 即 reactiveEffect,执行内部effect后，会返回一个将自身作为参数后调用run函数的执行结果
 */
function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(): unknown {
    if (!effect.active) {
      /**
       *  刚执行完 createReactiveEffect 时 active = true
       */
      return fn()
    }
    if (!effectStack.includes(effect)) {
      cleanup(effect)
      try {
        enableTracking()
        effectStack.push(effect)
        activeEffect = effect
        /**
         * 执行effect回调, return后依然会执行finally
         */
        return fn()
      } finally {
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  /**
   * 给effect赛了下值：
   * _isEffect: 是否有经历过effect
   * raw: effect参数函
   * active: 如果是!active 会run中执行 return fn(...args)
   * deps： 在track时收集dep，dep就是在追踪列表中对应的key,即targetMap.get(target).get(key)
   * options: 参数
   */
  effect.id = uid++
  effect.allowRecurse = !!options.allowRecurse
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  effect.deps = []
  effect.options = options
  return effect
}
/**
 * 将effect.deps清空
 */
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}
/**
 * 追踪响应： 利用Map键可以是对象，将需要被追踪的的对象作为键塞入到全局的targetMap中即可
 * track(目标， 类型， 键值)
 * 在 computed,reactive(Proxy->createGetter)、ref中被调用
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  if (!shouldTrack || activeEffect === undefined) {
    /**
     * 执行effect时，options.lazy!=true,就一定会执行run方法
     * 执行run方法之后 activeEffect 会赋值给 reactiveEffect的effect变量
     * 没被 effect 过，activeEffect 就会 === undefined
     * shouldTrack 默认为 true
     */
    return
  }
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    /**
     * 没被追踪 将 target -> set 到 targetMap
     * 而 target 在 targetMap 对应的值是 depsMap（初始化时是 new Map()）
     */
    targetMap.set(target, (depsMap = new Map()))
  }
  /**
   * 尝试在 depsMap 中获取 key
   */
  let dep = depsMap.get(key)
  if (!dep) {
    /**
     * 有获取到dep，说明 target.key 并没有被追踪,此时就在 depsMap 中塞一个值
     * 当执行了 depsMap.set(key, (dep = new Set())); 后, targetMap.get(target) 的值也会相应的改变
     */
    depsMap.set(key, (dep = new Set()))
  }
  if (!dep.has(activeEffect)) {
    /**
     * 这个 activeEffect 就是在 effect执行的时候的那个 activeEffect
     */
    dep.add(activeEffect)
    activeEffect.deps.push(dep)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  const effects = new Set<ReactiveEffect>()
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }

  effects.forEach(run)
}
