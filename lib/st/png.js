/**
 * PNG 角色卡读写（SillyTavern 的卡就是内嵌 tEXt 块的 PNG）。
 *
 * PNG 结构：签名(8) → 若干块 → IEND。每块 = 长度(4BE) + 类型(4) + 数据 + CRC32(4)。
 * 角色卡把 base64(JSON) 写进关键字为 chara（V2）或 ccv3（V3）的 tEXt 块。
 *
 * 自己实现解析与写回，不依赖 png-chunks-extract / png-chunk-text，
 * 这样插件对其他 npm 包零依赖。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32 查表（PNG 用标准多项式 0xEDB88320）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

/** 计算 CRC32。 */
export function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 这个 buffer 是不是 PNG。 */
export function isPng(buffer) {
  if (!buffer || buffer.length < 8) return false
  for (let i = 0; i < 8; i++) if (buffer[i] !== PNG_SIGNATURE[i]) return false
  return true
}

/**
 * 拆成块数组。
 * @param {Buffer} buffer
 * @returns {{ name: string, data: Buffer, raw: Buffer }[]}
 */
export function extractChunks(buffer) {
  if (!isPng(buffer)) throw new Error('不是 PNG 文件')
  const chunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const name = buffer.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new Error('PNG 块被截断：' + name)
    const data = buffer.subarray(dataStart, dataEnd)
    chunks.push({ name, data, raw: buffer.subarray(offset, dataEnd + 4) })
    offset = dataEnd + 4
    if (name === 'IEND') break
  }
  return chunks
}

/**
 * 把块数组重新拼成 PNG，并重算每块 CRC。
 * @param {{ name: string, data: Buffer }[]} chunks
 * @returns {Buffer}
 */
export function encodeChunks(chunks) {
  const parts = [PNG_SIGNATURE]
  for (const chunk of chunks) {
    const nameBuffer = Buffer.from(chunk.name, 'latin1')
    const body = chunk.data
    const header = Buffer.alloc(8)
    header.writeUInt32BE(body.length, 0)
    nameBuffer.copy(header, 4)
    const crcBuffer = Buffer.alloc(4)
    crcBuffer.writeUInt32BE(crc32(Buffer.concat([nameBuffer, body])), 0)
    parts.push(header, body, crcBuffer)
  }
  return Buffer.concat(parts)
}

/**
 * 解码一个 tEXt 块：数据是 keyword\0text（Latin-1）。
 * @param {Buffer} data
 * @returns {{ keyword: string, text: string }|null}
 */
export function decodeText(data) {
  const nul = data.indexOf(0)
  if (nul < 0) return null
  return {
    keyword: data.toString('latin1', 0, nul),
    text: data.toString('latin1', nul + 1),
  }
}

/**
 * 编码一个 tEXt 块的数据。
 * @param {string} keyword
 * @param {string} text
 * @returns {Buffer}
 */
export function encodeText(keyword, text) {
  return Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ])
}

/**
 * 从 PNG 里读出角色卡 JSON 文本。
 * V3（ccv3）优先，其次 V2（chara）。
 * @param {Buffer} buffer
 * @returns {string|null} JSON 文本；没有角色数据时 null
 */
export function readCharacterText(buffer) {
  const chunks = extractChunks(buffer)
  const texts = chunks
    .filter(c => c.name === 'tEXt')
    .map(c => decodeText(c.data))
    .filter(Boolean)

  const ccv3 = texts.find(t => t.keyword.toLowerCase() === 'ccv3')
  if (ccv3) return Buffer.from(ccv3.text, 'base64').toString('utf8')

  const chara = texts.find(t => t.keyword.toLowerCase() === 'chara')
  if (chara) return Buffer.from(chara.text, 'base64').toString('utf8')

  return null
}

/**
 * 把角色卡 JSON 写进 PNG：替换或插入 chara 与 ccv3 两个 tEXt 块。
 * @param {Buffer} pngBuffer 原图
 * @param {{ chara?: string, ccv3?: string }} payload JSON 文本
 * @returns {Buffer} 新 PNG
 */
export function writeCharacterText(pngBuffer, payload) {
  const chunks = extractChunks(pngBuffer)

  // 去掉已有的角色卡块
  const kept = chunks.filter(chunk => {
    if (chunk.name !== 'tEXt') return true
    const decoded = decodeText(chunk.data)
    if (!decoded) return true
    const keyword = decoded.keyword.toLowerCase()
    return keyword !== 'chara' && keyword !== 'ccv3'
  })

  // 插到 IEND 之前
  const iendIndex = kept.findIndex(c => c.name === 'IEND')
  const insertAt = iendIndex < 0 ? kept.length : iendIndex
  const additions = []
  if (payload.chara) {
    additions.push({
      name: 'tEXt',
      data: encodeText('chara', Buffer.from(payload.chara, 'utf8').toString('base64')),
    })
  }
  if (payload.ccv3) {
    additions.push({
      name: 'tEXt',
      data: encodeText('ccv3', Buffer.from(payload.ccv3, 'utf8').toString('base64')),
    })
  }
  kept.splice(insertAt, 0, ...additions)
  return encodeChunks(kept)
}

/**
 * 从 PNG 里读出图片尺寸（IHDR），供前端排版用。
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number }|null}
 */
export function readPngSize(buffer) {
  try {
    const chunks = extractChunks(buffer)
    const ihdr = chunks.find(c => c.name === 'IHDR')
    if (!ihdr || ihdr.data.length < 8) return null
    return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4) }
  } catch {
    return null
  }
}
/**
 * 读一张 PNG 角色卡：返回两个内嵌文本块的 JSON 文本。
 *
 * 与 {@link readCharacterText} 的区别：那个只返回「优先级最高的那一份」，
 * 这个把 chara(V2) 与 ccv3(V3) 分别交出来，便于调用方自行决定取哪个，
 * 也避免 V3 卡里 ccv3 与 chara 内容不一致时丢信息。
 *
 * @param {Buffer} buffer PNG 字节
 * @returns {{ json: string|null, ccv3: string|null }|null} 没有任何角色数据时返回 null
 * @throws {Error} buffer 不是合法 PNG（签名/块结构损坏）时抛出
 */
export function readCharacterFromPng(buffer) {
  const chunks = extractChunks(buffer)
  const texts = chunks
    .filter(c => c.name === 'tEXt')
    .map(c => decodeText(c.data))
    .filter(Boolean)

  const decode = entry => Buffer.from(entry.text, 'base64').toString('utf8')
  const ccv3Entry = texts.find(t => t.keyword.toLowerCase() === 'ccv3')
  const charaEntry = texts.find(t => t.keyword.toLowerCase() === 'chara')
  if (!ccv3Entry && !charaEntry) return null

  return {
    json: charaEntry ? decode(charaEntry) : null,
    ccv3: ccv3Entry ? decode(ccv3Entry) : null,
  }
}

/**
 * 把角色卡 JSON 写进 PNG，产出能被 SillyTavern 直接导入的卡图。
 *
 * 已有的 chara / ccv3 块会被替换（不会重复堆积），其余块原样保留并重算 CRC。
 * chara 与 ccv3 都省略时，等同于删除图里的角色数据。
 *
 * @param {Buffer} pngBuffer 底图 PNG（必须是合法 PNG）
 * @param {{ chara?: string|Object, ccv3?: string|Object }} payload
 *        JSON 文本或对象；对象会被 JSON.stringify
 * @returns {Buffer} 新的 PNG 字节
 * @throws {Error} pngBuffer 不是合法 PNG，或 payload 无法序列化时抛出
 */
export function writeCharacterToPng(pngBuffer, payload = {}) {
  const toText = value => {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }
  const chara = toText(payload.chara)
  const ccv3 = toText(payload.ccv3)
  if (!chara && !ccv3) {
    // 只删不写：仍然走一次重组，保证结果是干净 PNG
    return writeCharacterText(pngBuffer, {})
  }
  return writeCharacterText(pngBuffer, { chara, ccv3 })
}
