/**
 * Make a map and return a function for checking if a key
 * is in that map.
 * IMPORTANT: all calls of this function must be prefixed with
 * \/\*#\_\_PURE\_\_\*\/
 * So that rollup can tree-shake them if necessary.
 */
/**
 * 标记标签是否存在 (eg：判断是否为 native tag)
 * 逗号分割字符串数组， 返回 {div: true}
 * str: 目标，字符串数组
 * expectsLowerCase： 是否转换大写
 * 返回 目标校验的 boolean值 （div | DIV -> true）
 */
export function makeMap(
  str: string,
  expectsLowerCase?: boolean
): (key: string) => boolean {
  const map: Record<string, boolean> = Object.create(null)
  const list: Array<string> = str.split(',')
  for (let i = 0; i < list.length; i++) {
    map[list[i]] = true
  }
  return expectsLowerCase ? val => !!map[val.toLowerCase()] : val => !!map[val]
}
