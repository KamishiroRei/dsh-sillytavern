/**
 * 零依赖工具定义器。
 *
 * 插件装在 profile 树之外，无法 import '@deepseek-ai/dsh-tools'（裸包名在
 * profile 的运行时解析里只对 profile 内插件可见）。但 ctx.tools.register()
 * 接受的是普通 ToolDefinition 对象，所以我们直接构造它：
 *   - parameters 用 JSON Schema（ToolSchema.parameters 就是 JSON Schema）
 *   - execute 自己校验参数并在失败时抛错（registry 会转成 isError）
 *
 * 这样插件对其他 DSH 包零依赖，装到哪都能跑。
 */

/** 构造一个参数校验错误。 */
class ArgError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolArgumentError'
  }
}

/**
 * 从简化的字段表生成 JSON Schema。
 * @param {Record<string, {type: string, description?: string, required?: boolean, enum?: any[], items?: any, default?: any, minimum?: number, maximum?: number}>} fields
 */
export function schema(fields) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(fields || {})) {
    const node = { type: spec.type }
    if (spec.description) node.description = spec.description
    if (spec.enum) node.enum = spec.enum
    if (spec.items) node.items = spec.items
    if (spec.default !== undefined) node.default = spec.default
    // minimum / maximum 只用于本地 validateArgs 的区间检查，**不写进 schema**：
    // DSH 工具参数走 JSON Schema 的一个受限子集（type/enum/items/properties/required/
    // additionalProperties/oneOf/const），数值区间不在其中，写进去会让工具契约不合法。
    if (spec.type === 'array' && !node.items) node.items = { type: 'string' }
    properties[name] = node
    if (spec.required) required.push(name)
  }
  const out = { type: 'object', properties, additionalProperties: false }
  if (required.length) out.required = required
  return out
}

function typeOk(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return true
}

/** 按 schema 校验参数；不通过时抛出可读错误。 */
export function validateArgs(toolName, fields, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const out = {}
  for (const [name, spec] of Object.entries(fields || {})) {
    const value = input[name]
    if (value === undefined || value === null) {
      if (spec.required) throw new ArgError(toolName + ': 缺少必填参数 "' + name + '"')
      if (spec.default !== undefined) out[name] = spec.default
      continue
    }
    if (!typeOk(value, spec.type)) {
      throw new ArgError(toolName + ': 参数 "' + name + '" 应为 ' + spec.type + '，实际是 ' + (typeof value))
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new ArgError(toolName + ': 参数 "' + name + '" 必须是 ' + spec.enum.join(' / ') + ' 之一')
    }
    if (spec.type === 'number' || spec.type === 'integer') {
      if (spec.minimum !== undefined && value < spec.minimum) throw new ArgError(toolName + ': 参数 "' + name + '" 不能小于 ' + spec.minimum)
      if (spec.maximum !== undefined && value > spec.maximum) throw new ArgError(toolName + ': 参数 "' + name + '" 不能大于 ' + spec.maximum)
    }
    if (spec.type === 'array' && spec.items) {
      for (const item of value) {
        if (item !== null && typeof item === 'object' && spec.items.type === 'string') {
          throw new ArgError(toolName + ': 参数 "' + name + '" 的元素应为 string')
        }
        if (spec.items.type && typeof item !== 'object' && !typeOk(item, spec.items.type)) {
          throw new ArgError(toolName + ': 参数 "' + name + '" 的元素应为 ' + spec.items.type)
        }
      }
    }
    out[name] = value
  }
  return out
}

/**
 * 定义一个工具。
 * @param {Object} options
 * @param {string} options.name            工具名（全局唯一）
 * @param {string} options.description     给模型看的说明
 * @param {Record<string, any>} options.parameters
 * @param {(args: any, exec: any) => Promise<any>} options.execute  返回 JSON 值
 * @param {(args: any, value: any) => any[]} [options.render]        返回 content blocks
 * @param {(args: any, value: any) => any} [options.presentationMeta]
 */
export function defineTool(options) {
  const fields = options.parameters || {}
  const jsonSchema = schema(fields)
  return {
    name: options.name,
    description: options.description,
    parameters: jsonSchema,
    output: {
      schema: { type: 'object' },
      render: options.render || ((_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]),
      ...(options.presentationMeta ? { presentationMeta: options.presentationMeta } : {}),
    },
    async execute(args, exec) {
      const parsed = validateArgs(options.name, fields, args)
      const value = await options.execute(parsed, exec || {})
      return value === undefined ? {} : value
    },
  }
}

/** 统一的返回内容渲染：一段文本 JSON。 */
export function textRender(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}
