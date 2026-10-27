/**
 * dsh-sillytavern 客户端 bundle（ModuleLoader 格式，无构建步骤）。
 *
 * 这个文件是单文件 bundle：上面的 id 必须等于 loader entry 名（dsh-sillytavern），
 * 否则 ModuleLoader 会报 "loaded without registering dsh-sillytavern"。
 * 依赖只走平台模块（react / react-dom），其余全部自己实现——插件装在 profile 树外，
 * 裸包名解析不到。数据一律走 /dsh-sillytavern-api/*。
 *
 * 分节（搜索 "// ===== " 可跳转）：
 *   字符串与常量 / HTTP 客户端 / 轻量 Markdown 渲染 / 图标 / 运行期状态
 *   消息气泡 / 地图 / 角色卡 / 场景 / 日志 / 三栏舞台 / 设置页 / 样式 / apply
 */
window.__ModuleLoader__.load({
  id: 'dsh-sillytavern',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    // react-dom 只在需要把浮层挂到 body 时才用；拿不到就退化成原地渲染。
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { ReactDOM = null }

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ===== 字符串与常量 =====

    /** 插件标识：样式表归属、ModuleLoader id、路由前缀后缀都用它。 */
    const PLUGIN_ID = 'dsh-sillytavern'
    /**
     * 后端 HTTP 前缀。
     *
     * 不能带 /api：DSH 的 /api/* 整个被 RPC 桥接管，外部请求一律 401。
     * dsh-meme 同款做法是用一条独立顶层前缀。
     */
    const API_BASE = '/dsh-sillytavern-api'

    /** 中间舞台的四个面板。 */
    const CENTER_PANELS = [
      { id: 'map', label: '地图', hint: '格子地图与 token' },
      { id: 'scene', label: '场景', hint: '当前场景插图与环境' },
      { id: 'sheet', label: '角色卡', hint: '队伍成员数值' },
      { id: 'log', label: '日志', hint: '判定与事件记录' },
    ]

    /** 六维与衍生属性的中文名 + 图标语义。未知键走兜底。 */
    const ATTRIBUTE_LABELS = {
      str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力',
      siz: '体型', app: '外貌', pow: '意志', edu: '教育', luck: '幸运',
      san: '理智', mov: '移动', spirit: '精神',
    }

    /** 地形配色语义（真正的颜色在 CSS 里，用 --dsw-* 令牌派生）。 */
    const TERRAIN_TYPES = ['floor', 'wall', 'door', 'water', 'grass', 'stone', 'void']

    /** 日志条目类型的中文名。 */
    const LOG_KIND_LABELS = {
      roll: '掷骰', check: '判定', damage: '伤害', scene: '场景', system: '系统',
    }

    // ===== HTTP 客户端 =====

    /**
     * 发一个 JSON 请求并拆信封。
     *
     * 后端统一返回 { ok: true, data } 或 { ok: false, error }；非 JSON、非 2xx
     * 一律抛错。错误信息是中文，直接可以显示给用户。
     * @param {string} path - 相对 API_BASE 的路径，必须以 / 开头。
     * @param {{ method?: string, body?: any }} [init] - method 缺省 GET。
     * @returns {Promise<any>} 信封里的 data 字段。
     * @throws {Error} 网络失败、非 JSON 响应、或 ok !== true。
     */
    async function requestJson(path, init) {
      const options = init || {}
      const fetchImpl = typeof fetch === 'function' ? fetch : null
      if (!fetchImpl) throw new Error('当前环境没有 fetch，无法访问插件接口')
      const request = {
        method: options.method || 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }
      if (options.body !== undefined) {
        request.method = options.method || 'POST'
        request.headers['content-type'] = 'application/json'
        request.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetchImpl(API_BASE + path, request)
      } catch (error) {
        throw new Error('无法连接 dsh-sillytavern 接口：' + describeError(error))
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error('接口返回的不是 JSON（HTTP ' + response.status + '）')
      }
      if (!payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' && payload.error
          ? payload.error
          : '接口返回失败（HTTP ' + response.status + '）'
        throw new Error(message)
      }
      return payload.data
    }

    /** 把异常压成一行中文（用于错误提示，不吞掉原始信息）。 */
    function describeError(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      if (error.message) return String(error.message)
      return String(error)
    }

    /** 后端 API 的具名封装。 */
    const api = {
      /** 自检信息：版本、数据目录、角色/世界书数量。 */
      ping: () => requestJson('/ping'),
      /** UI 状态（布局、偏好）。 */
      state: () => requestJson('/state'),
      /** 浅合并写入 UI 状态。 */
      saveState: (patch) => requestJson('/state', { method: 'POST', body: patch }),
      /** 角色卡列表（不含正文，体积小）。 */
      characters: () => requestJson('/characters'),
      /** 单张角色卡的完整字段。 */
      character: (id) => requestJson('/characters/' + encodeURIComponent(id)),
      /** 世界书列表。 */
      worldbooks: () => requestJson('/worldbooks'),
      /** 开/关一本世界书。 */
      toggleWorldbook: (name, enabled) => requestJson('/worldbooks/toggle', {
        method: 'POST', body: { name, enabled },
      }),
      /** 用一段文本扫描世界书激活情况。 */
      scanWorldbook: (text) => requestJson('/worldbooks/scan', { method: 'POST', body: { text } }),
      /** 舞台内容：AI 决定放什么、长什么样。 */
      stage: (sessionId) => requestJson('/stage/' + encodeURIComponent(sessionId || 'default')),
      /** 跑团状态：地图/场景/角色卡/日志。 */
      trpg: (sessionId) => requestJson(sessionId ? '/trpg/' + encodeURIComponent(sessionId) : '/trpg'),
      /** 某个 DSH 会话对应的酒馆聊天记录。 */
      chat: (sessionId) => requestJson('/chat/' + encodeURIComponent(sessionId)),
      /** 从 SillyTavern 安装目录导入。 */
      importFrom: (stRoot, overwrite) => requestJson('/import', {
        method: 'POST', body: { stRoot, overwrite: Boolean(overwrite) },
      }),
      /** 预设列表。 */
      presets: () => requestJson('/presets'),
    }

    /**
     * 拼静态资源地址。
     *
     * 后端从插件配置的 assetRoot 读图（默认指向本机 Godot 项目的 UI 素材目录），
     * 只放行白名单扩展名。取不到时调用方自己降级到内联 SVG。
     * @param {string} group - 资源分组：glyph / painted / control / icon / panel / font。
     * @param {string} file - 文件名（不含目录，可含扩展名）。
     * @returns {string} 可直接放进 img/url() 的地址。
     */
    function assetUrl(group, file) {
      const name = String(file || '')
      // glyph / meter / panel / icon 这几组后端按 key 自动补 .png；字体等其它组按原样带扩展名。
      const needsExt = group === 'glyph' || group === 'painted' || group === 'meter'
        || group === 'panel' || group === 'action' || group === 'icon'
      const finalName = needsExt && !/\.[a-z0-9]+$/i.test(name) ? name + '.png' : name
      return API_BASE + '/assets/' + encodeURIComponent(group) + '/' + encodeURIComponent(finalName)
    }

    /** 角色头像地址；后端给 avatarUrl 时优先用后端那份。 */
    function avatarUrlOf(character) {
      if (!character) return ''
      if (typeof character.avatarUrl === 'string' && character.avatarUrl) return character.avatarUrl
      const file = character.avatar
      if (typeof file !== 'string' || !file) return ''
      return avatarUrlOf.raw ? avatarUrlOf.raw(file) : API_BASE + '/avatars/' + encodeURIComponent(file)
    }
    // 头像文件名可能带子目录（ST 的 png 名本身带扩展），encodeURIComponent 会转掉斜杠。
    avatarUrlOf.raw = (file) => API_BASE + '/avatars/' + String(file).split('/').map(encodeURIComponent).join('/')

    // ===== 轻量 Markdown 渲染 =====
    //
    // ST 用 showdown 把正文转 HTML；DSH 里不能引入额外依赖，这里按 ST 实际会出现的
    // 子集重写：代码块、行内代码、粗体、斜体、删除线、标题、引用、有序/无序列表、
    // 分割线、链接。不做 HTML 直通（安全），不做表格（ST 默认也不开）。
    // 额外一条 ST 特色：全角括号包起来的内容当「侧边动作」，渲染成淡色斜体。

    /** 行内标记扫描用的正则：顺序即优先级，粗体必须排在斜体前。 */
    const INLINE_RE = new RegExp(
      '(\\*\\*|__)([\\s\\S]+?)\\1'      // 1,2 粗体
      + '|(\\*|_)([\\s\\S]+?)\\3'        // 3,4 斜体
      + '|~~([\\s\\S]+?)~~'                  // 5 删除线
      + '|`([^`\\n]+)`'                     // 6 行内代码
      + '|!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)' // 7,8 图片
      + '|\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)'  // 9,10 链接
      + '|（([^（）\\n]+)）',                   // 11 侧边动作
      'g',
    )

    /** 只放行安全协议，其余当纯文本（防止 javascript: 之类进到 href）。 */
    function safeHref(url) {
      const value = String(url || '').trim()
      if (!value) return null
      if (/^(https?:|mailto:|#|\/|\.\/)/i.test(value)) return value
      return null
    }

    /**
     * 解析一段行内标记，返回 React 节点数组。
     * @param {string} text - 单行（或段落内）文本。
     * @param {string} keyPrefix - React key 前缀，保证跨块唯一。
     * @returns {Array} React 子节点。
     */
    function parseInline(text, keyPrefix) {
      const out = []
      if (!text) return out
      const re = new RegExp(INLINE_RE.source, 'g')
      let last = 0
      let match
      let index = 0
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) out.push(text.slice(last, match.index))
        const key = keyPrefix + '-i' + (index++)
        if (match[2] !== undefined) {
          out.push(h('strong', { key }, parseInline(match[2], key)))
        } else if (match[4] !== undefined) {
          out.push(h('em', { key }, parseInline(match[4], key)))
        } else if (match[5] !== undefined) {
          out.push(h('del', { key }, parseInline(match[5], key)))
        } else if (match[6] !== undefined) {
          out.push(h('code', { key, className: 'st-inline-code' }, match[6]))
        } else if (match[7] !== undefined) {
          const src = safeHref(match[8])
          if (src) out.push(h('img', { key, className: 'st-md-img', src, alt: match[7] || '' }))
          else out.push(match[0])
        } else if (match[9] !== undefined) {
          const href = safeHref(match[10])
          if (href) {
            out.push(h('a', {
              key,
              className: 'st-md-link',
              href,
              target: href.startsWith('#') ? undefined : '_blank',
              rel: 'noreferrer noopener',
            }, parseInline(match[9], key)))
          } else {
            out.push(match[0])
          }
        } else if (match[11] !== undefined) {
          out.push(h('span', { key, className: 'st-side-note' }, match[0]))
        }
        last = re.lastIndex
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    /** 分割线判定：至少三个同样的 - * _ 。 */
    function isHr(line) {
      const trimmed = line.trim()
      return /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    }

    /**
     * 把扁平的列表项按缩进折成树。
     * @param {Array<{ indent: number, text: string, ordered: boolean }>} items - 顺序即出现顺序。
     * @returns {Array} 每个节点形如 { text, ordered, indent, children }。
     */
    function buildListTree(items) {
      const root = { indent: -1, children: [] }
      const stack = [root]
      for (const item of items) {
        while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) stack.pop()
        const node = { text: item.text, ordered: item.ordered, indent: item.indent, children: [] }
        stack[stack.length - 1].children.push(node)
        stack.push(node)
      }
      return root.children
    }

    /**
     * 渲染一层列表；相邻但编号方式不同的项拆成两个列表，嵌套项递归成子列表。
     * @param {Array} nodes - buildListTree 的产物。
     * @param {string} prefix - React key 前缀。
     * @returns {Array} ul/ol React 节点。
     */
    function renderListLevel(nodes, prefix) {
      const groups = []
      let current = null
      for (const node of nodes) {
        if (!current || current.ordered !== node.ordered) {
          current = { ordered: node.ordered, items: [] }
          groups.push(current)
        }
        current.items.push(node)
      }
      return groups.map((group, groupIndex) => {
        const tag = group.ordered ? 'ol' : 'ul'
        const className = group.ordered ? 'st-md-list st-md-ol' : 'st-md-list st-md-ul'
        return h(tag, { key: prefix + '-g' + groupIndex, className }, group.items.map((node, itemIndex) => {
          const key = prefix + '-g' + groupIndex + '-i' + itemIndex
          const children = [h('span', { key: 'txt' }, parseInline(node.text, key))]
          if (node.children.length) children.push(renderListLevel(node.children, key + '-n'))
          return h('li', { key }, children)
        }))
      })
    }

    /**
     * 把整段 Markdown 渲染成 React 节点。
     *
     * 流式输出时文本可能停在半个标记中间：未闭合的代码块按「已开始」渲染，
     * 未闭合的行内标记退化成纯文本，不会把半个星号显示出来。
     * @param {string} text - Markdown 源文本。
     * @param {{ streaming?: boolean, keyPrefix?: string }} [options]
     * @returns {Array} React 子节点。
     */
    function renderMarkdown(text, options) {
      const opts = options || {}
      const prefix = opts.keyPrefix || 'md'
      const source = String(text === undefined || text === null ? '' : text)
      if (!source) return []
      const lines = source.split('\n')
      const out = []
      let i = 0
      let blockIndex = 0

      const pushBlock = (node) => {
        out.push(h('div', { key: prefix + '-b' + (blockIndex++), className: 'st-md-block' }, node))
      }

      while (i < lines.length) {
        const line = lines[i]
        const trimmedRaw = line.trim()

        // 空行
        if (trimmedRaw === '') { i += 1; continue }

        // 代码块
        const fence = /^```(.*)$/.exec(trimmedRaw)
        if (fence) {
          const lang = fence[1].trim()
          const body = []
          i += 1
          let closed = false
          while (i < lines.length) {
            if (/^```\s*$/.test(lines[i].trim())) { closed = true; i += 1; break }
            body.push(lines[i])
            i += 1
          }
          pushBlock(h('pre', {
            className: 'st-code-block',
            'data-lang': lang || undefined,
            'data-open': closed ? undefined : 'true',
          }, h('code', null, body.join('\n'))))
          continue
        }

        // 标题
        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmedRaw)
        if (heading) {
          const level = Math.min(6, heading[1].length)
          pushBlock(h('div', { className: 'st-md-heading st-md-h' + level }, parseInline(heading[2], prefix + '-h' + i)))
          i += 1
          continue
        }

        // 分割线
        if (isHr(trimmedRaw)) {
          pushBlock(h('hr', { className: 'st-md-hr' }))
          i += 1
          continue
        }

        // 引用：连续 > 行合并
        if (/^>\s?/.test(trimmedRaw)) {
          const quoted = []
          while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
            quoted.push(lines[i].trim().replace(/^>\s?/, ''))
            i += 1
          }
          pushBlock(h('blockquote', { className: 'st-md-quote' }, renderMarkdown(quoted.join('\n'), { keyPrefix: prefix + '-q' + i })))
          continue
        }

        // 列表：连续 -/*/+ 或 1. 2. 行，按缩进算层级
        const listMatch = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line)
        if (listMatch) {
          const ordered = listMatch[2] !== '-' && listMatch[2] !== '*' && listMatch[2] !== '+'
          const items = []
          while (i < lines.length) {
            const m = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(lines[i])
            if (!m) break
            items.push({ indent: m[1].replace(/\t/g, '  ').length, text: m[4], ordered: m[2] !== '-' && m[2] !== '*' && m[2] !== '+' })
            i += 1
          }
          pushBlock(renderListLevel(buildListTree(items), prefix + '-l' + i))
          continue
        }

        // 段落：连续非空、非其他块的行合并
        const paragraph = [line]
        i += 1
        while (i < lines.length) {
          const probe = lines[i]
          const probeTrim = probe.trim()
          if (probeTrim === '') break
          if (/^```/.test(probeTrim) || /^(#{1,6})\s+/.test(probeTrim) || /^>\s?/.test(probeTrim)) break
          if (isHr(probeTrim)) break
          if (/^(\s*)([-*+]|(\d+)[.)])\s+/.test(probe)) break
          paragraph.push(probe)
          i += 1
        }
        pushBlock(h('p', { className: 'st-md-p' }, parseInline(paragraph.join('\n'), prefix + '-p' + i)))
      }
      return out
    }

    // ===== 图标（内联 SVG） =====
    //
    // 本机有一套像素风图标素材（D:\Game\tianjie-fall\assets\ui），后端可以经
    // /assets 路由取到已配置了 assetRoot 时优先用真图（见 Glyph 组件）。
    // 取不到就退到这里的内联 SVG：24x24 视图框、currentColor 描边，跟随主题色。

    /** 图标路径表；值是 24x24 视图框内的 path d。 */
    const ICON_PATHS = {
      // 六维
      strength: 'M4 10v4M20 10v4M7 9v6M17 9v6M7 12h10',
      agility: 'M20 4c-6 1-11 6-12 12l-2 4 4-2c6-1 11-6 12-12zM8 16l-3-3',
      constitution: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM12 9v3M10.5 10.5h3M10.5 13h3',
      intelligence: 'M4 5h6a2 2 0 012 2v12a2 2 0 00-2-2H4zM20 5h-6a2 2 0 00-2 2v12a2 2 0 012-2h6z',
      wisdom: 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
      charisma: 'M12 3l2.6 5.5 6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.4l6-.9z',
      // 元素
      fire: 'M12 3c3 4 6 6 6 10a6 6 0 01-12 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4 1-7 2-9z',
      water: 'M12 3c4 5 7 8 7 11a7 7 0 01-14 0c0-3 3-6 7-11z',
      wind: 'M3 8h11a3 3 0 100-6M3 14h15a3 3 0 110 6M3 11h7',
      earth: 'M3 20l6-12 4 7 3-5 5 10z',
      light: 'M12 6a6 6 0 100 12 6 6 0 000-12zM12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1',
      dark: 'M20 14a8 8 0 01-10-10 8 8 0 1010 10z',
      // 界面
      map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15',
      scene: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M8 9a1.5 1.5 0 100-.01',
      sheet: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
      log: 'M4 5h16M4 10h16M4 15h10M4 20h7',
      dice: 'M12 2l9 5v10l-9 5-9-5V7zM12 2v10M3 7l9 5 9-5M12 12v10',
      close: 'M5 5l14 14M19 5L5 19',
      chevron: 'M9 6l6 6-6 6',
      users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-2a5 5 0 015-5h4a5 5 0 015 5v2M17 4a3.5 3.5 0 010 7M18 14h1a4 4 0 014 4v3',
      book: 'M4 4h7v16H4zM13 4h7v16h-7zM4 4a3 3 0 003-3M13 4a3 3 0 013-3',
      settings: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 005.7 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 13.9H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 7.3l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0010 3.6V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
      panel: 'M3 4h18v16H3zM9 4v16',
      expand: 'M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6',
      collapse: 'M9 4v5H4M15 20v-5h5M20 4l-6 6M4 20l6-6',
      heart: 'M12 20s-7-4.5-7-9.5A4 4 0 0112 7a4 4 0 017 3.5C19 15.5 12 20 12 20z',
      shield: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
      sword: 'M18 3l3 3-9 9-3-3zM6 18l-3 3M9 15l-3 3M7 13l4 4',
      bag: 'M6 8h12l1 12H5zM9 8V6a3 3 0 016 0v2',
      plus: 'M12 5v14M5 12h14',
      refresh: 'M20 12a8 8 0 11-3-6.2M20 4v5h-5',
    }

    /**
     * 渲染一个内联 SVG 图标。
     * @param {{ name: string, size?: number, className?: string, title?: string }} props
     *   name 取 ICON_PATHS 的键；未知名退成圆点，不抛错。
     * @returns {Object} React 元素。
     */
    function Icon(props) {
      const name = props && props.name
      const size = (props && props.size) || 16
      const path = ICON_PATHS[name] || 'M12 8a4 4 0 100 8 4 4 0 000-8z'
      return h('svg', {
        className: 'st-icon' + (props && props.className ? ' ' + props.className : ''),
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: path }))
    }

    /**
     * 优先用后端真图、失败自动退回内联 SVG 的图标槽。
     *
     * 素材来自本机 Godot 项目的 UI 库，经 /assets 路由取回；没配 assetRoot 或
     * 文件缺失时 onError 会切到内联版本，绝不出现红叉占位。
     * @param {{ group: string, file: string, fallback: string, size?: number }} props
     * @returns {Object} React 元素。
     */
    function Glyph(props) {
      const [failed, setFailed] = useState(false)
      const size = props.size || 24
      const src = useMemo(() => assetUrl(props.group, props.file), [props.group, props.file])
      useEffect(() => { setFailed(false) }, [src])
      if (failed || !src) return h(Icon, { name: props.fallback, size })
      return h('img', {
        className: 'st-glyph',
        src,
        width: size,
        height: size,
        alt: '',
        'aria-hidden': 'true',
        loading: 'lazy',
        draggable: 'false',
        onError: () => setFailed(true),
      })
    }

    // ===== 运行期状态 =====
    //
    // 模块级只放「订阅者集合 + 快照缓存」，真正的值全部在 apply 里用 useState 持有。
    // 这样卸载/重挂不会继承上一轮的状态句柄（HMR 下最容易踩的坑）。

    /** 一个最小可订阅快照：getSnapshot 引用稳定，subscribe 返回退订函数。 */
    function createSnapshotSource(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    // ===== 消息气泡 =====

    /**
     * 从消息 extra 里取世界书激活记录。
     *
     * 后端可能给 [{uid, comment}] 或 string[]；两种都归一成 { uid, title }。
     * @param {any} extra - 消息 extra 对象。
     * @returns {Array<{ uid: any, title: string }>} 归一后的条目，无记录时为空数组。
     */
    function readActivatedWorldInfo(extra) {
      if (!extra || typeof extra !== 'object') return []
      const raw = extra.activatedWorldInfo || extra.worldInfo || extra.activatedWorldEntries
      if (!Array.isArray(raw)) return []
      return raw.map((entry, index) => {
        if (typeof entry === 'string') return { uid: index, title: entry }
        if (entry && typeof entry === 'object') {
          return {
            uid: entry.uid === undefined ? index : entry.uid,
            title: String(entry.comment || entry.title || entry.name || ('条目 ' + (entry.uid === undefined ? index : entry.uid))),
          }
        }
        return { uid: index, title: String(entry) }
      })
    }

    /**
     * 从消息里取可点选项。
     *
     * 优先级：后端 extra.choices > 正文里的 <options>a|b|c</options>。
     * 正文里的 options 标签会从显示文本中剔除（不裸露标签）。
     * @param {string} text - 消息正文。
     * @param {any} extra - 消息 extra。
     * @returns {{ choices: string[], text: string }} 选项与去掉标签后的正文。
     */
    function extractChoices(text, extra) {
      const source = String(text === undefined || text === null ? '' : text)
      const fromExtra = extra && Array.isArray(extra.choices)
        ? extra.choices.map(choice => String(choice || '').trim()).filter(Boolean)
        : []
      const tagRe = /<\s*options\s*>([\s\S]*?)<\s*\/\s*options\s*>/gi
      const fromTag = []
      let match
      while ((match = tagRe.exec(source)) !== null) {
        for (const piece of match[1].split('|')) {
          const value = piece.trim()
          if (value) fromTag.push(value)
        }
      }
      const stripped = source.replace(tagRe, '').replace(/\n{3,}/g, '\n\n').trim()
      return { choices: fromExtra.length ? fromExtra : fromTag, text: fromExtra.length ? source.trim() : stripped }
    }

    /** 角色名首字（没有头像时的圆形兜底）。 */
    function initialOf(name) {
      const value = String(name || '').trim()
      if (!value) return '·'
      const first = Array.from(value)[0]
      return first || '·'
    }

    /**
     * 角色头像；加载失败退成首字圆牌，绝不留红叉。
     * @param {{ src?: string, name?: string, size?: number, className?: string }} props
     * @returns {Object} React 元素。
     */
    function Avatar(props) {
      const [broken, setBroken] = useState(false)
      const src = props && props.src
      const size = (props && props.size) || 40
      const style = { width: size, height: size }
      useEffect(() => { setBroken(false) }, [src])
      if (!src || broken) {
        return h('span', {
          className: 'st-avatar st-avatar-fallback' + (props && props.className ? ' ' + props.className : ''),
          style,
          'aria-hidden': 'true',
        }, initialOf(props && props.name))
      }
      return h('img', {
        className: 'st-avatar' + (props && props.className ? ' ' + props.className : ''),
        style,
        src,
        alt: '',
        'aria-hidden': 'true',
        draggable: 'false',
        loading: 'lazy',
        onError: () => setBroken(true),
      })
    }

    /**
     * 世界书激活角标：默认收起，点开列出触发条目。
     * @param {{ entries: Array<{ uid: any, title: string }> }} props
     * @returns {Object|null} React 元素；没有条目时返回 null。
     */
    function WorldInfoBadge(props) {
      const entries = (props && props.entries) || []
      const [open, setOpen] = useState(false)
      if (!entries.length) return null
      return h('div', { className: 'st-wi' + (open ? ' is-open' : '') }, [
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'st-wi-toggle',
          onClick: () => setOpen(value => !value),
          'aria-expanded': open,
        }, [
          h(Icon, { key: 'icon', name: 'book', size: 12 }),
          h('span', { key: 'label' }, '世界书 · ' + entries.length + ' 条'),
          h(Icon, { key: 'caret', name: 'chevron', size: 11, className: 'st-wi-caret' }),
        ]),
        open ? h('ul', { key: 'list', className: 'st-wi-list' }, entries.map((entry, index) => (
          h('li', { key: String(entry.uid) + '-' + index }, entry.title)
        ))) : null,
      ])
    }

    /**
     * 选项按钮组：点一下就把该选项作为用户输入发出去。
     * @param {{ choices: string[], onPick: (choice: string) => void, disabled?: boolean }} props
     * @returns {Object|null} React 元素。
     */
    function ChoiceRow(props) {
      const choices = (props && props.choices) || []
      const onPick = props && props.onPick
      if (!choices.length) return null
      return h('div', { className: 'st-choices', role: 'group', 'aria-label': '可选行动' }, choices.map((choice, index) => (
        h('button', {
          key: index,
          type: 'button',
          className: 'st-choice',
          disabled: Boolean(props && props.disabled),
          onClick: () => { if (onPick) onPick(choice) },
        }, [
          h('span', { key: 'n', className: 'st-choice-index' }, String(index + 1)),
          h('span', { key: 't' }, choice),
        ])
      )))
    }

    /**
     * 酒馆消息气泡：头像 + 角色名 + 正文 + 世界书角标 + 选项。
     *
     * 正文走本文件的轻量 Markdown；全角括号内容作为侧重动作淡色斜体。
     * @param {{
     *   role: 'assistant'|'user'|'system',
     *   name: string,
     *   avatar?: string,
     *   text: string,
     *   extra?: any,
     *   streaming?: boolean,
     *   onPickChoice?: (choice: string) => void,
     * }} props
     * @returns {Object} React 元素。
     */
    function TavernBubble(props) {
      const role = (props && props.role) || 'assistant'
      const parsed = useMemo(() => extractChoices(props && props.text, props && props.extra), [props && props.text, props && props.extra])
      const worldInfo = useMemo(() => readActivatedWorldInfo(props && props.extra), [props && props.extra])
      const body = useMemo(() => renderMarkdown(parsed.text, { streaming: Boolean(props && props.streaming) }), [parsed.text, props && props.streaming])
      const name = (props && props.name) || (role === 'user' ? '你' : '酒馆')
      return h('article', { className: 'st-bubble st-bubble-' + role }, [
        h('header', { key: 'head', className: 'st-bubble-head' }, [
          h(Avatar, { key: 'a', src: props && props.avatar, name, size: 32 }),
          h('span', { key: 'n', className: 'st-bubble-name' }, name),
          props && props.streaming ? h('span', { key: 's', className: 'st-bubble-streaming' }, '正在书写…') : null,
        ]),
        h('div', { key: 'body', className: 'st-bubble-body' }, body.length ? body : h('p', { className: 'st-md-p st-muted' }, '（空白）')),
        h(WorldInfoBadge, { key: 'wi', entries: worldInfo }),
        h(ChoiceRow, { key: 'choices', choices: parsed.choices, onPick: props && props.onPickChoice, disabled: !(props && props.onPickChoice) }),
      ])
    }

// ===== 地图渲染 =====
    //
    // 数据契约（trpg-gm 冻结）：
    //   { width, height, tileSize, name,
    //     cells:[{x,y,type,label,fog}],
    //     tokens:[{id,x,y,name,color,icon,kind}],
    //     features:[{x,y,type,data}],
    //     fog:{enabled,revealed:[[x,y]]}, grid:{visible,color} }
    // 地形在 cells[].type（floor|wall|door|water|grass|stone|void），
    // features 是可交互物件（door|trap|chest|stairs|note）。
    // 坐标原点左上、x 向右、y 向下、单位=格。

    /** 兜底地图尺寸：后端还没给地图时也画出一块可看的空白棋盘。 */
    const EMPTY_MAP = { width: 12, height: 9, tileSize: 48, cells: [], tokens: [], features: [] }

    /**
     * 把后端地图归一成渲染器能吃的形状。
     *
     * 容错点：缺 cells 时用 features/默认地板补；坐标越界的格子直接丢弃（防画到框外）；
     * token 坐标转成数字，非数字的整条丢弃。
     * @param {any} raw - /trpg 返回的 map 字段，可能是 null。
     * @returns {{ map: Object, synthetic: boolean }} 归一后的地图 + 是否为兜底棋盘。
     */
    function normalizeMap(raw) {
      if (!raw || typeof raw !== 'object') {
        return { map: buildBlankMap(EMPTY_MAP.width, EMPTY_MAP.height, EMPTY_MAP.tileSize), synthetic: true }
      }
      const width = clampInt(raw.width, 12, 1, 200)
      const height = clampInt(raw.height, 9, 1, 200)
      const tileSize = clampInt(raw.tileSize, 48, 12, 160)
      const cells = []
      const seen = new Set()
      for (const cell of Array.isArray(raw.cells) ? raw.cells : []) {
        if (!cell || typeof cell !== 'object') continue
        const cx = Math.trunc(Number(cell.x))
        const cy = Math.trunc(Number(cell.y))
        // 只认落在棋盘内的格子：越界或非数字一律丢弃，避免画到框外。
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue
        const x = cx
        const y = cy
        const key = x + ':' + y
        if (seen.has(key)) continue
        seen.add(key)
        cells.push({
          x,
          y,
          type: TERRAIN_TYPES.includes(cell.type) ? cell.type : 'floor',
          label: typeof cell.label === 'string' ? cell.label : '',
          fog: Boolean(cell.fog),
          icon: typeof cell.icon === 'string' ? cell.icon : '',
        })
      }
      const tokens = []
      for (const token of Array.isArray(raw.tokens) ? raw.tokens : []) {
        if (!token || typeof token !== 'object') continue
        const x = Number(token.x)
        const y = Number(token.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        tokens.push({
          id: token.id === undefined ? ('token-' + tokens.length) : String(token.id),
          x: Math.max(0, Math.min(width - 1, Math.trunc(x))),
          y: Math.max(0, Math.min(height - 1, Math.trunc(y))),
          name: String(token.name || '未命名'),
          color: typeof token.color === 'string' && token.color ? token.color : '',
          icon: typeof token.icon === 'string' ? token.icon : '',
          kind: typeof token.kind === 'string' ? token.kind : '',
          avatar: typeof token.avatar === 'string' ? token.avatar : '',
        })
      }
      const features = []
      for (const feature of Array.isArray(raw.features) ? raw.features : []) {
        if (!feature || typeof feature !== 'object') continue
        const x = Number(feature.x)
        const y = Number(feature.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        features.push({
          x: Math.trunc(x),
          y: Math.trunc(y),
          type: String(feature.type || 'note'),
          icon: typeof feature.icon === 'string' ? feature.icon : '',
          data: feature.data && typeof feature.data === 'object' ? feature.data : {},
        })
      }
      const fogEnabled = Boolean(raw.fog && raw.fog.enabled)
      const gridVisible = !(raw.grid && raw.grid.visible === false)
      return {
        map: {
          width,
          height,
          tileSize,
          name: String(raw.name || ''),
          cells,
          tokens,
          features,
          fogEnabled,
          gridVisible,
          gridColor: raw.grid && typeof raw.grid.color === 'string' ? raw.grid.color : '',
          revealed: Array.isArray(raw.fog && raw.fog.revealed) ? raw.fog.revealed : [],
        },
        synthetic: false,
      }
    }

    /** 数值收敛成 [lo, hi] 内的整数；非法值回 fallback。 */
    function clampInt(value, fallback, lo, hi) {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(hi, Math.max(lo, Math.trunc(n)))
    }

    /** 造一块全地板的空白棋盘（用于「还没开始跑团」的空态）。 */
    function buildBlankMap(width, height, tileSize) {
      const cells = []
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) cells.push({ x, y, type: 'floor', label: '', fog: false })
      }
      return {
        width, height, tileSize, name: '', cells, tokens: [], features: [],
        fogEnabled: false, gridVisible: true, gridColor: '', revealed: [],
      }
    }

    /** 地形 → CSS 类后缀（配色在样式表里按 --dsw-* 派生）。 */
    function terrainClass(type) {
      return 'st-tile st-tile-' + (TERRAIN_TYPES.includes(type) ? type : 'floor')
    }

    /**
     * 格子地图渲染器（SVG）。
     *
     * 交互：鼠标悬停显示格子坐标与地块标签；点 token 弹出详情卡；点空格清除选中。
     * 迷雾：fogEnabled 为真时，未探索格盖半透明遮罩。
     * @param {{
     *   raw: any,
     *   syncScroll?: boolean,
     *   onSelectToken?: (token: Object) => void,
     *   selectedTokenId?: string,
     * }} props
     * @returns {Object} React 元素。
     */
    function MapCanvas(props) {
      const normalized = useMemo(() => normalizeMap(props && props.raw), [props && props.raw])
      const map = normalized.map
      const [hover, setHover] = useState(null)
      const [picked, setPicked] = useState(null)
      const size = map.tileSize
      const widthPx = map.width * size
      const heightPx = map.height * size
      const cellIndex = useMemo(() => {
        const table = new Map()
        for (const cell of map.cells) table.set(cell.x + ':' + cell.y, cell)
        return table
      }, [map.cells])
      const selectedId = (props && props.selectedTokenId) || (picked && picked.id) || ''
      const activeToken = picked || (selectedId
        ? map.tokens.find(token => token.id === selectedId) || null
        : null)

      const handlePick = useCallback((token) => {
        setPicked(token)
        if (props && typeof props.onSelectToken === 'function') props.onSelectToken(token)
      }, [props && props.onSelectToken])

      const tiles = []
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const cell = cellIndex.get(x + ':' + y) || { x, y, type: 'floor', label: '', fog: false }
          const fogged = map.fogEnabled && cell.fog !== false
          tiles.push(h('rect', {
            key: 't' + x + '-' + y,
            x: x * size,
            y: y * size,
            width: size,
            height: size,
            className: terrainClass(cell.type),
          }))
          // 地形图标（后端派生好的 key）：只画在非迷雾格上，尺寸压到 60% 免得糊满整格。
          if (cell.icon && !fogged && cell.type !== 'floor') {
            tiles.push(h('image', {
              key: 'i' + x + '-' + y,
              href: assetUrl('glyph', cell.icon),
              x: x * size + size * 0.2,
              y: y * size + size * 0.2,
              width: size * 0.6,
              height: size * 0.6,
              preserveAspectRatio: 'xMidYMid meet',
              className: 'st-tile-icon',
            }))
          }
          if (fogged) {
            tiles.push(h('rect', {
              key: 'f' + x + '-' + y,
              x: x * size,
              y: y * size,
              width: size,
              height: size,
              className: 'st-tile-fog',
            }))
          }
        }
      }

      const features = map.features.map((feature, index) => h('g', {
        key: 'ft' + index,
        className: 'st-feature st-feature-' + feature.type,
        transform: 'translate(' + (feature.x * size + size / 2) + ',' + (feature.y * size + size / 2) + ')',
      }, [
        h('circle', { key: 'c', r: size * 0.3 }),
        feature.icon
          ? h('image', {
            key: 'i',
            href: assetUrl('glyph', feature.icon),
            x: -size * 0.24,
            y: -size * 0.24,
            width: size * 0.48,
            height: size * 0.48,
            preserveAspectRatio: 'xMidYMid meet',
            className: 'st-feature-icon',
          })
          : h('text', {
            key: 't',
            className: 'st-feature-mark',
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            'font-size': Math.round(size * 0.34),
          }, feature.type === 'door' ? '门' : feature.type === 'chest' ? '箱'
            : feature.type === 'trap' ? '陷' : feature.type === 'stairs' ? '梯' : '★'),
      ]))

      const tokens = map.tokens.map((token) => {
        const cx = token.x * size + size / 2
        const cy = token.y * size + size / 2
        const r = size * 0.36
        const fill = token.color || ''
        const isActive = token.id === selectedId
        return h('g', {
          key: 'tk-' + token.id,
          className: 'st-token' + (isActive ? ' is-active' : ''),
          transform: 'translate(' + cx + ',' + cy + ')',
          onClick: (event) => { event.stopPropagation(); handlePick(token) },
          role: 'button',
          tabIndex: 0,
          'aria-label': '棋子 ' + token.name,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handlePick(token) }
          },
        }, [
          h('circle', { key: 'c', r, className: 'st-token-disc', style: fill ? { fill } : undefined }),
          token.icon
            ? h('image', {
              key: 'i',
              href: assetUrl('glyph', token.icon),
              x: -r * 0.72,
              y: -r * 0.72,
              width: r * 1.44,
              height: r * 1.44,
              preserveAspectRatio: 'xMidYMid meet',
              className: 'st-token-icon',
            })
            : h('text', {
              key: 't',
              className: 'st-token-label',
              'text-anchor': 'middle',
              'dominant-baseline': 'central',
              'font-size': Math.round(size * 0.34),
            }, initialOf(token.name)),
        ])
      })

      return h('div', { className: 'st-map' }, [
        h('div', { key: 'bar', className: 'st-map-bar' }, [
          h('span', { key: 'name', className: 'st-map-name' }, map.name || '战场'),
          h('span', { key: 'dim', className: 'st-map-dim' }, map.width + ' × ' + map.height),
          hover ? h('span', { key: 'hover', className: 'st-map-hover' },
            '(' + hover.x + ', ' + hover.y + ')' + (hover.label ? ' · ' + hover.label : ' · ' + hover.typeLabel)) : null,
          normalized.synthetic ? h('span', { key: 'empty', className: 'st-map-empty-hint' }, '尚未开始跑团') : null,
        ]),
        h('div', { key: 'stage', className: 'st-map-stage' }, [
          h('svg', {
            key: 'svg',
            className: 'st-map-svg',
            viewBox: '0 0 ' + widthPx + ' ' + heightPx,
            width: widthPx,
            height: heightPx,
            onMouseLeave: () => setHover(null),
            onClick: () => setPicked(null),
            role: 'img',
            'aria-label': '格子地图，' + map.width + ' 乘 ' + map.height,
          }, [
            // 顺序即层级：命中层必须最底，否则它盖住 token，点击永远落到空格上（token 点不动）。
            h('g', { key: 'hit', className: 'st-map-hit' }, buildHitRects(map, cellIndex, setHover)),
            h('g', { key: 'terrain' }, tiles),
            map.gridVisible ? h('g', { key: 'grid', className: 'st-grid' }, buildGridLines(map)) : null,
            h('g', { key: 'features' }, features),
            h('g', { key: 'tokens' }, tokens),
          ]),
        ]),
        activeToken ? h('div', { key: 'detail', className: 'st-token-detail' }, [
          h(Avatar, { key: 'a', src: activeToken.avatar, name: activeToken.name, size: 34 }),
          h('div', { key: 'info', className: 'st-token-detail-info' }, [
            h('strong', { key: 'n' }, activeToken.name),
            h('span', { key: 'pos', className: 'st-muted' }, '(' + activeToken.x + ', ' + activeToken.y + ')' + (activeToken.kind ? ' · ' + activeToken.kind : '')),
          ]),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'st-icon-btn',
            onClick: () => setPicked(null),
            'aria-label': '关闭详情',
          }, h(Icon, { name: 'close', size: 13 })),
        ]) : null,
      ])
    }

    /** 网格线：一条 path 画完，避免每格一个元素。 */
    function buildGridLines(map) {
      const size = map.tileSize
      const parts = []
      for (let x = 0; x <= map.width; x += 1) parts.push('M' + (x * size) + ' 0V' + (map.height * size))
      for (let y = 0; y <= map.height; y += 1) parts.push('M0 ' + (y * size) + 'H' + (map.width * size))
      return h('path', { d: parts.join(''), className: 'st-grid-line' })
    }

    /** 透明命中层：负责悬停坐标显示。 */
    function buildHitRects(map, cellIndex, setHover) {
      const size = map.tileSize
      const rects = []
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const cell = cellIndex.get(x + ':' + y)
          rects.push(h('rect', {
            key: 'h' + x + '-' + y,
            x: x * size,
            y: y * size,
            width: size,
            height: size,
            fill: 'transparent',
            onMouseEnter: () => setHover({
              x,
              y,
              typeLabel: TERRAIN_LABELS[cell && cell.type ? cell.type : 'floor'] || '地板',
              label: cell && cell.label ? cell.label : '',
            }),
          }))
        }
      }
      return rects
    }

    /** 地形中文名（悬停提示用）。 */
    const TERRAIN_LABELS = {
      floor: '地板', wall: '墙', door: '门', water: '水', grass: '草地', stone: '石地', void: '虚空',
    }

    // ===== 角色卡面板 =====

    /** 属性键 → 图标名；未知键用通用图标。 */
    const ATTRIBUTE_ICONS = {
      str: 'strength', dex: 'agility', con: 'constitution', int: 'intelligence',
      wis: 'wisdom', cha: 'charisma', spirit: 'wisdom', pow: 'shield', edu: 'book',
      siz: 'constitution', app: 'charisma', luck: 'charisma', san: 'shield', mov: 'agility',
    }

    /** 属性键 → 素材库 glyph 文件名（没有对应素材时退回内联 SVG）。 */
    const ATTRIBUTE_GLYPHS = {
      str: 'glyph_strength', dex: 'glyph_agility', con: 'glyph_constitution',
      int: 'glyph_intelligence', wis: 'glyph_spirit', cha: 'glyph_luck',
      spirit: 'glyph_spirit', pow: 'glyph_ward', edu: 'glyph_arcana',
      luck: 'glyph_luck', san: 'glyph_bulwark', mov: 'glyph_haste',
    }

    /**
     * 数值条：血量/魔力/护盾通用。
     *
     * 后端已经把 percent 与 bar 贴图名算好了（vital.percent / vital.bar），
     * 有就直接用；没有（老数据或前端自己造的）才用 cur/max 现算，
     * 保证任何形状的输入都能画出一条正确的条。
     * @param {{ cur?: number, max?: number, percent?: number, bar?: string, tone?: string }} props
     * @returns {Object} React 元素。
     */
    function StatBar(props) {
      const cur = Number(props && props.cur) || 0
      const max = Number(props && props.max) || 0
      const given = Number(props && props.percent)
      const percent = Number.isFinite(given) ? given : (max > 0 ? (cur / max) * 100 : 0)
      const clamped = Math.max(0, Math.min(100, percent))
      const tone = (props && props.tone) || 'health'
      const barKey = props && props.bar
      const track = h('div', { key: 'track', className: 'st-statbar-track' }, [
        barKey ? h(Glyph, {
          key: 'tex',
          group: 'meter',
          file: barKey,
          fallback: 'heart',
          size: 16,
          className: 'st-statbar-tex',
        }) : null,
        h('div', { key: 'fill', className: 'st-statbar-fill', style: { width: clamped.toFixed(2) + '%' } }),
      ])
      return h('div', { className: 'st-statbar st-statbar-' + tone + (barKey ? ' has-tex' : '') }, [
        track,
        h('span', { key: 'text', className: 'st-statbar-text' }, cur + ' / ' + max),
      ])
    }

    /**
     * 一张角色卡。
     *
     * 属性表按后端给的键顺序渲染；六维用素材 glyph，未知键用内联 SVG 兜底。
     * @param {{ sheet: Object, compact?: boolean }} props
     * @returns {Object} React 元素。
     */
    function SheetCard(props) {
      const sheet = (props && props.sheet) || {}
      const hp = sheet.hp || {}
      const mp = sheet.mp || null
      const shield = sheet.shield && Number(sheet.shield.max) > 0 ? sheet.shield : null
      const attributes = sheet.attributes && typeof sheet.attributes === 'object' ? sheet.attributes : {}
      const status = Array.isArray(sheet.status) ? sheet.status : []
      const items = Array.isArray(sheet.items) ? sheet.items : []
      const conditions = Array.isArray(sheet.conditions) ? sheet.conditions : []
      // 后端给了 attributeList（含中文名与图标 key）就按它画，否则退回 attributes 键表。
      const attrRows = Array.isArray(sheet.attributeList) && sheet.attributeList.length
        ? sheet.attributeList.map((entry) => ({
          key: String(entry && entry.key ? entry.key : ''),
          label: String((entry && entry.name) || ATTRIBUTE_LABELS[entry && entry.key] || (entry && entry.key) || '?'),
          value: entry && entry.value,
          icon: entry && entry.icon ? String(entry.icon) : '',
        }))
        : Object.keys(attributes).map(key => ({
          key,
          label: ATTRIBUTE_LABELS[key] || String(key).toUpperCase(),
          value: attributes[key],
          icon: ATTRIBUTE_GLYPHS[key] || '',
        }))
      // 状态徽章：conditions 带图标/回合数时优先，status 只是名字数组。
      const badges = conditions.length
        ? conditions.map((entry, index) => ({
          key: 'c' + index,
          name: String((entry && entry.name) || entry),
          icon: entry && entry.icon ? String(entry.icon) : '',
          duration: entry && Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
        }))
        : status.map((entry, index) => ({
          key: 's' + index,
          name: typeof entry === 'string' ? entry : String(entry && entry.name ? entry.name : entry),
          icon: '',
          duration: null,
        }))
      return h('section', { className: 'st-sheet' }, [
        h('header', { key: 'head', className: 'st-sheet-head' }, [
          h(Avatar, { key: 'a', src: sheet.avatar, name: sheet.name, size: 40 }),
          h('div', { key: 'id', className: 'st-sheet-id' }, [
            h('strong', { key: 'n' }, String(sheet.name || '无名角色')),
            sheet.system ? h('span', { key: 'sys', className: 'st-muted' }, String(sheet.system)) : null,
          ]),
          Number.isFinite(Number(sheet.ac)) ? h('span', {
            key: 'ac',
            className: 'st-ac',
            title: '护甲等级',
          }, [h(Icon, { key: 'i', name: 'shield', size: 12 }), String(sheet.ac)]) : null,
        ]),
        h('div', { key: 'vitals', className: 'st-sheet-vitals' }, [
          h('div', { key: 'hp', className: 'st-vital' }, [
            h('span', { key: 'l', className: 'st-vital-label' }, [h(Icon, { key: 'i', name: 'heart', size: 12 }), '生命']),
            h(StatBar, { key: 'b', cur: hp.cur, max: hp.max, percent: hp.percent, bar: hp.bar, tone: 'health' }),
          ]),
          mp ? h('div', { key: 'mp', className: 'st-vital' }, [
            h('span', { key: 'l', className: 'st-vital-label' }, [h(Icon, { key: 'i', name: 'water', size: 12 }), '魔力']),
            h(StatBar, { key: 'b', cur: mp.cur, max: mp.max, percent: mp.percent, bar: mp.bar, tone: 'mana' }),
          ]) : null,
          shield ? h('div', { key: 'sh', className: 'st-vital' }, [
            h('span', { key: 'l', className: 'st-vital-label' }, [h(Icon, { key: 'i', name: 'shield', size: 12 }), '护盾']),
            h(StatBar, { key: 'b', cur: shield.cur, max: shield.max, percent: shield.percent, bar: shield.bar, tone: 'shield' }),
          ]) : null,
        ]),
        attrRows.length ? h('div', { key: 'attrs', className: 'st-attr-grid' }, attrRows.map(row => {
          const icon = ATTRIBUTE_ICONS[row.key] || 'dice'
          return h('div', { key: row.key || row.label, className: 'st-attr' }, [
            row.icon
              ? h(Glyph, { key: 'g', group: 'glyph', file: row.icon, fallback: icon, size: 20 })
              : h(Icon, { key: 'g', name: icon, size: 18 }),
            h('span', { key: 'v', className: 'st-attr-value' }, String(row.value)),
            h('span', { key: 'l', className: 'st-attr-label' }, row.label),
          ])
        })) : null,
        badges.length ? h('div', { key: 'status', className: 'st-status-row' }, badges.map(badge => (
          h('span', { key: badge.key, className: 'st-status-chip', title: badge.duration === null ? undefined : ('剩余 ' + badge.duration + ' 回合') }, [
            badge.icon
              ? h(Glyph, { key: 'i', group: 'glyph', file: badge.icon, fallback: 'potion', size: 13 })
              : null,
            String(badge.name) + (badge.duration === null ? '' : ' ' + badge.duration + '回合'),
          ])
        ))) : null,
        items.length ? h('div', { key: 'items', className: 'st-items' }, [
          h('div', { key: 'title', className: 'st-section-title' }, [h(Icon, { key: 'i', name: 'bag', size: 12 }), '物品']),
          h('ul', { key: 'list', className: 'st-item-list' }, items.map((item, index) => (
            h('li', { key: index, title: item && item.desc ? String(item.desc) : undefined }, [
              item && item.icon
                ? h(Glyph, { key: 'i', group: 'glyph', file: String(item.icon), fallback: 'bag', size: 13 })
                : null,
              h('span', { key: 'n', className: 'st-item-name' }, String((item && item.name) || '物品')),
              item && item.qty !== undefined && item.qty !== null
                ? h('span', { key: 'q', className: 'st-item-qty' }, '×' + String(item.qty))
                : null,
            ])
          ))),
        ]) : null,
        sheet.notes ? h('p', { key: 'notes', className: 'st-sheet-notes' }, String(sheet.notes)) : null,
      ])
    }

    /**
     * 角色卡面板：多张卡时用分页签切换。
     * @param {{ sheets: Array<Object>, emptyHint?: string }} props
     * @returns {Object} React 元素。
     */
    function SheetPanel(props) {
      const sheets = Array.isArray(props && props.sheets) ? props.sheets : []
      const [activeId, setActiveId] = useState('')
      useEffect(() => {
        if (!sheets.length) { if (activeId) setActiveId(''); return }
        if (!sheets.some(sheet => String(sheet.id) === activeId)) setActiveId(String(sheets[0].id))
      }, [sheets, activeId])
      if (!sheets.length) return h(EmptyState, { icon: 'sheet', text: (props && props.emptyHint) || '还没有角色卡 · 让 GM 建立队伍或绑定角色卡' })
      const active = sheets.find(sheet => String(sheet.id) === activeId) || sheets[0]
      return h('div', { className: 'st-sheets' }, [
        sheets.length > 1 ? h('div', { key: 'tabs', className: 'st-sheet-tabs' }, sheets.map(sheet => (
          h('button', {
            key: String(sheet.id),
            type: 'button',
            className: 'st-sheet-tab' + (String(sheet.id) === String(active.id) ? ' is-active' : ''),
            onClick: () => setActiveId(String(sheet.id)),
          }, String(sheet.name || '无名'))
        ))) : null,
        h(SheetCard, { key: 'card-' + String(active.id), sheet: active }),
      ])
    }

    // ===== 场景面板 =====

    /**
     * 场景面板：大图 + 说明。图来自后端的 image/url 字段，加载失败退成占位。
     * @param {{ scene: Object }} props
     * @returns {Object} React 元素。
     */
    function ScenePanel(props) {
      const scene = (props && props.scene) || null
      const [broken, setBroken] = useState(false)
      const image = scene ? String(scene.image || scene.url || '') : ''
      useEffect(() => { setBroken(false) }, [image])
      if (!scene || (!image && !scene.description && !scene.text && !scene.name && !scene.title)) {
        return h(EmptyState, { icon: 'scene', text: '还没有场景 · 让 GM 描述你在哪里' })
      }
      const title = String(scene.title || scene.name || '当前场景')
      const text = String(scene.text || scene.description || '')
      const meta = []
      if (scene.timeOfDay) meta.push(String(scene.timeOfDay))
      if (scene.weather) meta.push(String(scene.weather))
      if (scene.ambiance) meta.push(String(scene.ambiance))
      // 用 <img> 而不是 background-image：加载失败能拿到 onError 退回占位，
      // background-image 失败只会静默露出底色，用户看到一片空白。
      const imageBlock = image && !broken
        ? h('img', {
          key: 'img',
          className: 'st-scene-image',
          src: image,
          alt: title,
          loading: 'lazy',
          draggable: 'false',
          onError: () => setBroken(true),
        })
        : h('div', { key: 'img-ph', className: 'st-scene-image st-scene-placeholder' },
          h(Icon, { name: 'scene', size: 32 }))
      return h('div', { className: 'st-scene' }, [
        imageBlock,
        h('div', { key: 'body', className: 'st-scene-body' }, [
          h('h3', { key: 't', className: 'st-scene-title' }, title),
          meta.length ? h('div', { key: 'm', className: 'st-scene-meta' }, meta.map((entry, index) => (
            h('span', { key: index, className: 'st-status-chip' }, entry)
          ))) : null,
          text ? h('div', { key: 'd', className: 'st-scene-text' }, renderMarkdown(text, { keyPrefix: 'scene' })) : null,
        ]),
      ])
    }

    // ===== 日志面板 =====

    /**
     * 事件日志：判定/掷骰/伤害用颜色与数值区分，自动滚到底部。
     * @param {{ log: Array<Object> }} props
     * @returns {Object} React 元素。
     */
    function LogPanel(props) {
      const log = Array.isArray(props && props.log) ? props.log : []
      const boxRef = useRef(null)
      useEffect(() => {
        const node = boxRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [log.length])
      if (!log.length) return h(EmptyState, { icon: 'log', text: '还没有记录 · 掷骰与判定会出现在这里' })
      return h('div', { className: 'st-log', ref: boxRef }, log.map((entry, index) => {
        const kind = entry && LOG_KIND_LABELS[entry.kind] ? entry.kind : 'system'
        const tone = entry && entry.success === true ? ' ok' : entry && entry.success === false ? ' bad' : ''
        return h('div', {
          key: entry && entry.id !== undefined ? String(entry.id) : 'log' + index,
          className: 'st-log-row st-log-' + kind + tone,
        }, [
          h('span', { key: 'k', className: 'st-log-kind' }, LOG_KIND_LABELS[kind]),
          h('span', { key: 't', className: 'st-log-title' }, String((entry && (entry.title || entry.text)) || '')),
          entry && entry.detail ? h('span', { key: 'd', className: 'st-log-detail' }, String(entry.detail)) : null,
          entry && entry.total !== undefined && entry.total !== null
            ? h('span', { key: 'v', className: 'st-log-total' }, String(entry.total))
            : null,
        ])
      }))
    }

    /** 空态占位（统一外观）。 */
    function EmptyState(props) {
      return h('div', { className: 'st-empty' }, [
        h(Icon, { key: 'i', name: (props && props.icon) || 'log', size: 26 }),
        h('p', { key: 't' }, String((props && props.text) || '暂无内容')),
      ])
    }

    // ===== 三栏跑团舞台 =====
    //
    // 用户要的是「中间地图、左侧关掉、右侧对话」。DSH 主区是对话流，没法直接塞三栏，
    // 所以这里做成一个全屏浮层：fixed 定位盖住主区，内部分左/中/右三栏，
    // 中间是舞台（地图/场景/角色卡/日志四个 tab），右栏自带迷你输入框
    // （浮层盖住了原生输入框，必须自带才能继续说话）。

    /**
     * 布局默认值；后端 /state 里存的就是这几项。
     *
     * splitRatio 的可用区间必须与后端一致（后端夹在 0.1~0.6 之间），
     * 前端自己先夹一遍，避免「拖完回读发现跳了一下」。
     */
    const SPLIT_MIN = 0.1
    const SPLIT_MAX = 0.6
    const DEFAULT_LAYOUT = {
      trpgLayout: true,
      centerPanel: 'map',
      leftCollapsed: false,
      splitRatio: 0.58,
    }

    /**
     * 建一个三栏浮层的开关控制器（apply 里建一次，两个 slot 共享）。
     *
     * 不放模块级是为了 HMR 与卸载重挂时不继承上一轮的开关状态；
     * 组件通过 useSnapshot 订阅。
     * @returns {{ getSnapshot: () => { open: boolean }, subscribe: Function, open: Function, close: Function, toggle: Function }}
     */
    function createStageController() {
      const source = createSnapshotSource({ open: false })
      return {
        getSnapshot: source.getSnapshot,
        subscribe: source.subscribe,
        open: () => source.set({ open: true }),
        close: () => source.set({ open: false }),
        toggle: () => source.set({ open: !source.getSnapshot().open }),
      }
    }

    /**
     * 订阅外部快照；宿主 React 缺 useSyncExternalStore 时退化成 useState + effect。
     * @param {{ getSnapshot: Function, subscribe: Function }} source - 快照源。
     * @returns {any} 当前快照值。
     */
    function useSnapshot(source) {
      const subscribe = source && source.subscribe
      const getSnapshot = source && source.getSnapshot
      const canSync = typeof React.useSyncExternalStore === 'function' && subscribe && getSnapshot
      const [fallback, setFallback] = useState(() => (getSnapshot ? getSnapshot() : undefined))
      useEffect(() => {
        if (canSync || !subscribe) return undefined
        return subscribe(() => setFallback(getSnapshot()))
      }, [source])
      if (canSync) return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return fallback
    }

    /**
     * 横向分割条拖拽。
     * @param {number} initial - 初始比例。
     * @param {{ current: any }} containerRef - 三栏容器。
     * @param {(ratio: number) => void} onChange - 松手时回调一次（用于落盘）。
     * @returns {[number, (event: any) => void]} 当前比例与 mousedown 处理函数。
     */
    function useSplitDrag(initial, containerRef, onChange) {
      const [ratio, setRatio] = useState(initial)
      const draggingRef = useRef(false)
      useEffect(() => { setRatio(initial) }, [initial])
      const onPointerDown = useCallback((event) => {
        event.preventDefault()
        const container = containerRef.current
        if (!container) return
        draggingRef.current = true
        const move = (moveEvent) => {
          if (!draggingRef.current) return
          const rect = container.getBoundingClientRect()
          if (!rect.width) return
          setRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (moveEvent.clientX - rect.left) / rect.width)))
        }
        const up = () => {
          draggingRef.current = false
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          setRatio((current) => { if (onChange) onChange(current); return current })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }, [containerRef, onChange])
      return [ratio, onPointerDown]
    }

    /**
     * 右栏对话：读后端 /chat/<sessionId>，自带迷你输入框与选项点击。
     * @param {{ sessionId: string, refreshKey: number, onSend: (text: string) => void }} props
     * @returns {Object} React 元素。
     */
    function StageChat(props) {
      const sessionId = props && props.sessionId
      const [state, setState] = useState({ loading: true, error: '', data: null })
      const [draft, setDraft] = useState('')
      const [tick, setTick] = useState(0)
      const listRef = useRef(null)
      const refreshKey = props && props.refreshKey

      /** 拉一次消息。抽出来是因为「外部刷新」和「轮询」都要用。 */
      const load = useCallback(() => {
        if (!sessionId) { setState({ loading: false, error: '没有当前会话', data: null }); return }
        api.chat(sessionId).then((data) => {
          setState({ loading: false, error: '', data })
        }).catch((error) => {
          setState((current) => ({ ...current, loading: false, error: describeError(error) }))
        })
      }, [sessionId])

      useEffect(() => { load() }, [load, refreshKey])

      // 轮询：跑团时 GM 的回复是异步写进后端的，不轮询用户要手动点刷新才看得到。
      // 页面不在前台时跳过，避免切走还在打接口。
      useEffect(() => {
        if (!sessionId) return undefined
        const timer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          setTick((value) => value + 1)
        }, 3000)
        return () => window.clearInterval(timer)
      }, [sessionId])

      useEffect(() => { if (tick > 0) load() }, [tick, load])

      const messages = state.data && Array.isArray(state.data.messages) ? state.data.messages : []

      useEffect(() => {
        const node = listRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [messages.length])

      const emit = useCallback((text) => {
        const value = String(text || '').trim()
        if (!value) return
        if (props && typeof props.onSend === 'function') props.onSend(value)
      }, [props && props.onSend])

      const submit = useCallback(() => {
        const text = draft.trim()
        if (!text) return
        setDraft('')
        emit(text)
      }, [draft, emit])

      return h('div', { className: 'st-chat' }, [
        h('div', { key: 'list', className: 'st-chat-list', ref: listRef }, [
          state.loading && !messages.length ? h('div', { key: 'ld', className: 'st-chat-hint' }, '读取对话…') : null,
          state.error ? h('div', { key: 'err', className: 'st-chat-hint st-warn' }, state.error) : null,
          !state.loading && !state.error && !messages.length
            ? h('div', { key: 'empty', className: 'st-chat-hint' }, '这段会话还没有酒馆消息 · 在下方输入开始')
            : null,
          messages.map((message, index) => {
            const role = message && message.role === 'user' ? 'user' : 'assistant'
            return h(TavernBubble, {
              key: (message && (message.id || message.seq)) || index,
              role,
              name: message && (message.name || (role === 'user' ? '你' : '酒馆')),
              avatar: message && message.avatarUrl,
              text: message && message.content,
              extra: message && message.extra,
              streaming: Boolean(message && message.streaming),
              onPickChoice: emit,
            })
          }),
        ]),
        h('div', { key: 'composer', className: 'st-chat-composer' }, [
          h('textarea', {
            key: 'ta',
            className: 'st-chat-input',
            rows: 2,
            value: draft,
            placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            },
          }),
          h('button', {
            key: 'send',
            type: 'button',
            className: 'st-btn st-btn-primary st-chat-send',
            disabled: !draft.trim(),
            onClick: submit,
          }, '发送'),
        ]),
      ])
    }

    /**
     * 左栏：队伍角色卡与世界书开关，可收起成窄轨。
     * @param {{
     *   characters: Array<Object>, worldbooks: Array<Object>, activeCharacterId: string,
     *   onPickCharacter: (id: string) => void, onToggleWorldbook: (name: string, enabled: boolean) => void,
     *   collapsed: boolean, onToggleCollapsed: () => void,
     * }} props
     * @returns {Object} React 元素。
     */
    function StageAside(props) {
      const characters = (props && props.characters) || []
      const worldbooks = (props && props.worldbooks) || []
      if (props && props.collapsed) {
        return h('div', { className: 'st-aside st-aside-collapsed' }, h('button', {
          type: 'button',
          className: 'st-icon-btn',
          title: '展开左栏',
          'aria-label': '展开左栏',
          onClick: props.onToggleCollapsed,
        }, h(Icon, { name: 'panel', size: 15 })))
      }
      return h('div', { className: 'st-aside' }, [
        h('div', { key: 'head', className: 'st-aside-head' }, [
          h('span', { key: 't', className: 'st-aside-title' }, [h(Icon, { key: 'i', name: 'users', size: 13 }), '队伍']),
          h('button', {
            key: 'c',
            type: 'button',
            className: 'st-icon-btn',
            title: '收起左栏',
            'aria-label': '收起左栏',
            onClick: props && props.onToggleCollapsed,
          }, h(Icon, { name: 'collapse', size: 12 })),
        ]),
        h('div', { key: 'chars', className: 'st-aside-list' },
          characters.length
            ? characters.map((character) => {
              const id = String(character.id === undefined ? character.name : character.id)
              const active = id === String((props && props.activeCharacterId) || '')
              return h('button', {
                key: id,
                type: 'button',
                className: 'st-aside-row' + (active ? ' is-active' : ''),
                onClick: () => { if (props && props.onPickCharacter) props.onPickCharacter(id) },
                title: character.description || character.name,
              }, [
                h(Avatar, { key: 'a', src: avatarUrlOf(character), name: character.name, size: 26 }),
                h('span', { key: 'n', className: 'st-aside-name' }, String(character.name || '未命名')),
              ])
            })
            : h('div', { key: 'empty', className: 'st-aside-empty' }, '还没有角色卡')),
        h('div', { key: 'wb-head', className: 'st-aside-head' }, [
          h('span', { key: 't', className: 'st-aside-title' }, [h(Icon, { key: 'i', name: 'book', size: 13 }), '世界书']),
        ]),
        h('div', { key: 'wbs', className: 'st-aside-list' },
          worldbooks.length
            ? worldbooks.map((book) => h('label', { key: String(book.name), className: 'st-aside-row st-aside-toggle' }, [
              h('input', {
                key: 'cb',
                type: 'checkbox',
                checked: Boolean(book.enabled),
                onChange: (event) => { if (props && props.onToggleWorldbook) props.onToggleWorldbook(String(book.name), event.target.checked) },
              }),
              h('span', { key: 'n', className: 'st-aside-name' }, String(book.name)),
              h('span', { key: 'c', className: 'st-aside-count' }, book.entries === undefined ? '' : String(book.entries)),
            ]))
            : h('div', { key: 'empty', className: 'st-aside-empty' }, '还没有世界书')),
      ])
    }

    /**
     * 三栏跑团浮层。
     *
     * 数据全部走 HTTP：布局存 /state，舞台取 /trpg，左栏取 /characters 与 /worldbooks，
     * 右栏取 /chat/<sessionId>。任一路失败只影响自己那一栏，不会拖垮整个浮层。
     * @param {{
     *   open: boolean, onClose: () => void, sessionId: string,
     *   sendPrompt: (text: string) => void,
     * }} props
     * @returns {Object|null} React 元素；关闭时返回 null。
     */
    function TrpgOverlay(props) {
      const open = Boolean(props && props.open)
      const sessionId = (props && props.sessionId) || ''
      const onClose = props && props.onClose
      const sendPrompt = props && props.sendPrompt
      const [layout, setLayout] = useState(DEFAULT_LAYOUT)
      const [stageData, setStageData] = useState(null)
      const [stageError, setStageError] = useState('')
      const [characters, setCharacters] = useState([])
      const [worldbooks, setWorldbooks] = useState([])
      const [refreshKey, setRefreshKey] = useState(0)
      const [busy, setBusy] = useState(false)
      const containerRef = useRef(null)
      const saveTimer = useRef(0)
      /** 最近一次布局快照；写盘延迟 300ms，期间可能又改了几次，取最新的那份。 */
      const latestLayout = useRef(null)

      // 打开时读一次布局；之后的改动由本地状态 + POST 负责。
      useEffect(() => {
        if (!open) return undefined
        let alive = true
        api.state().then((data) => {
          if (!alive || !data) return
          setLayout((current) => ({
            ...current,
            trpgLayout: data.trpgLayout === undefined ? current.trpgLayout : Boolean(data.trpgLayout),
            centerPanel: CENTER_PANELS.some((panel) => panel.id === data.centerPanel) ? data.centerPanel : current.centerPanel,
            leftCollapsed: data.leftCollapsed === undefined ? current.leftCollapsed : Boolean(data.leftCollapsed),
            splitRatio: Number.isFinite(Number(data.splitRatio))
              ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(data.splitRatio)))
              : current.splitRatio,
          }))
        }).catch(() => { /* 布局读不到就用默认值，不阻断跑团 */ })
        return () => { alive = false }
      }, [open])

      // 舞台数据：打开时立即拉一次，之后每 5 秒轮询（跑团状态是持续变化的）。
      useEffect(() => {
        if (!open) return undefined
        let alive = true
        let timer = 0
        const tick = () => {
          if (!alive) return
          // 舞台内容（模型决定）+ 跑团状态（引擎存档）并行取；舞台是主展示面。
          Promise.all([
            api.stage(sessionId || undefined).catch(() => null),
            api.trpg(sessionId || undefined).catch(() => null),
          ]).then(([stageDoc, trpgDoc]) => {
            if (!alive) return
            setStageData({ ...(trpgDoc || {}), stagePanels: stageDoc && Array.isArray(stageDoc.panels) ? stageDoc.panels : [] })
            setStageError('')
            setBusy(false)
          }).catch((error) => {
            if (!alive) return
            setStageError(describeError(error))
            setBusy(false)
          })
          timer = window.setTimeout(tick, 5000)
        }
        setBusy(true)
        tick()
        return () => { alive = false; if (timer) window.clearTimeout(timer) }
      }, [open, sessionId, refreshKey])

      // 左栏低频数据：打开时拉一次，点刷新再拉。
      useEffect(() => {
        if (!open) return undefined
        let alive = true
        api.characters().then((rows) => { if (alive) setCharacters(Array.isArray(rows) ? rows : []) }).catch(() => {})
        api.worldbooks().then((rows) => { if (alive) setWorldbooks(Array.isArray(rows) ? rows : []) }).catch(() => {})
        return () => { alive = false }
      }, [open, refreshKey])

      /**
       * 布局改动：本地立即生效，300ms 内的连续改动合并成一次写盘。
       *
       * 副作用（定时器/请求）放在 setState 之外：更新器必须保持纯函数，
       * 否则 StrictMode 或并发渲染下会重复触发写盘。
       * @param {Object} patch - 要合并的布局字段。
       * @returns {void}
       */
      const patchLayout = useCallback((patch) => {
        setLayout((current) => {
          latestLayout.current = { ...current, ...patch }
          return latestLayout.current
        })
        if (saveTimer.current) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
          const snapshot = latestLayout.current
          if (!snapshot) return
          api.saveState(snapshot).catch(() => { /* 存不上不影响本次使用 */ })
        }, 300)
      }, [])

      useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current) }, [])

      const handleSplit = useCallback((ratio) => patchLayout({ splitRatio: ratio }), [patchLayout])
      const [splitRatio, onSplitDown] = useSplitDrag(layout.splitRatio, containerRef, handleSplit)

      const handleToggleWorldbook = useCallback((name, enabled) => {
        setWorldbooks((current) => current.map((book) => (String(book.name) === name ? { ...book, enabled } : book)))
        api.toggleWorldbook(name, enabled).catch(() => {
          setWorldbooks((current) => current.map((book) => (String(book.name) === name ? { ...book, enabled: !enabled } : book)))
        })
      }, [])

      const handlePickCharacter = useCallback((id) => {
        setLayout((current) => ({ ...current, activeCharacterId: id }))
        api.saveState({ activeCharacterId: id }).catch(() => {})
      }, [])

      // Esc 关闭：只在打开时挂，卸载即摘。
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (onClose) onClose()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [open, onClose])

      if (!open) return null

      const trpg = stageData || {}
      const stagePanels = Array.isArray(trpg.stagePanels) ? trpg.stagePanels : []
      const leftCollapsed = Boolean(layout.leftCollapsed)
      // splitRatio 只决定右栏（对话栏）占多宽；左栏固定，中栏吃掉剩余。
      // 之前左右都用百分比且相加为 100%，中栏被挤成 0。
      const rightWidth = (splitRatio * 100).toFixed(2) + '%'


      let centerBody
      if (!stagePanels.length) {
        centerBody = h('div', { className: 'st-stage-empty' }, [
          h(Icon, { key: 'i', name: 'scene', size: 26 }),
          h('p', { key: 't' }, '舞台上还没有内容'),
          h('p', { key: 'd', className: 'st-muted' }, '需要地图、角色卡或线索时，AI 会按当下的情境自己决定放什么。'),
        ])
      } else {
        centerBody = h('div', { className: 'st-panels' }, stagePanels.map((panel) => (
          h(StagePanel, { key: panel.id, panel })
        )))
      }

      // 第一段：还没选模组 → 只显示 Lobby，别的什么都不显示。
      // 用户要求：先选模组再进去，进去以后左侧不要多余内容。
      const entered = Boolean(trpg.entered || (trpg.activeCharacterId && trpg.activeCharacterId !== ''))
      const activeCharacter = characters.find((c) => String(c.id || c.name) === String(trpg.activeCharacterId || '')) || null
      if (!entered) {
        return h('div', { className: 'st-stage st-stage-lobby', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择模组' }, [
          h('div', { key: 'top', className: 'st-stage-top' }, [
            h('span', { key: 'title', className: 'st-stage-title' }, [h(Icon, { key: 'i', name: 'dice', size: 15 }), '酒馆模式']),
            h('span', { key: 'spacer', className: 'st-stage-spacer' }),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'st-icon-btn',
              title: '关闭',
              'aria-label': '关闭',
              onClick: onClose,
            }, h(Icon, { name: 'close', size: 14 })),
          ]),
          h('div', { key: 'body', className: 'st-lobby-wrap' }, h(TavernLobby, {
            characters,
            busy,
            onPick: (id) => {
              api.state().catch(() => null)
              handlePickCharacter(id)
              setRefreshKey((k) => k + 1)
            },
          })),
        ])
      }

      return h('div', { className: 'st-stage', role: 'dialog', 'aria-modal': 'true', 'aria-label': '跑团模式' }, [
        h(TavernTopBar, {
          key: 'topbar',
          character: activeCharacter,
          worldbooks,
          stageOpen: true,
          onToggleStage: () => setRefreshKey((k) => k + 1),
          onToggleWorldbook: handleToggleWorldbook,
          onExit: () => {
            // 换模组：清掉当前绑定，回到 Lobby
            if (window.confirm) { /* noop：用下面直接退出 */ }
            handlePickCharacter('')
            setRefreshKey((k) => k + 1)
          },
        }),
        h('div', { key: 'top', className: 'st-stage-top st-stage-top-hidden' }, [
          h('span', { key: 'title', className: 'st-stage-title' }, [h(Icon, { key: 'i', name: 'dice', size: 15 }), '跑团模式']),
          trpg.encounter && trpg.encounter.name
            ? h('span', { key: 'enc', className: 'st-stage-chip' }, '战斗：' + String(trpg.encounter.name))
            : null,
          h('span', { key: 'spacer', className: 'st-stage-spacer' }),
          busy ? h('span', { key: 'busy', className: 'st-muted' }, '同步中…') : null,
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'st-icon-btn',
            title: '刷新舞台',
            'aria-label': '刷新舞台',
            onClick: () => setRefreshKey((key) => key + 1),
          }, h(Icon, { name: 'refresh', size: 14 })),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'st-icon-btn',
            title: '退出跑团模式（Esc）',
            'aria-label': '退出跑团模式',
            onClick: onClose,
          }, h(Icon, { name: 'close', size: 14 })),
        ]),
        stageError ? h('div', { key: 'err', className: 'st-stage-error' }, stageError) : null,
        h('div', { key: 'body', className: 'st-stage-body', ref: containerRef }, [
          h('div', {
            key: 'left',
            className: 'st-col st-col-left' + (leftCollapsed ? ' is-collapsed' : ''),
            style: leftCollapsed ? undefined : { flex: '0 0 auto' },
          }, h(StageAside, {
            characters,
            worldbooks,
            activeCharacterId: layout.activeCharacterId || '',
            onPickCharacter: handlePickCharacter,
            onToggleWorldbook: handleToggleWorldbook,
            collapsed: leftCollapsed,
            onToggleCollapsed: () => patchLayout({ leftCollapsed: !leftCollapsed }),
          })),
          leftCollapsed ? null : h('div', {
            key: 'split1',
            className: 'st-split',
            role: 'separator',
            'aria-orientation': 'vertical',
            onMouseDown: onSplitDown,
          }),
          // 中栏不再有固定 tab：内容与形状由模型决定（stage_publish / stage_patch）。
          h('div', { key: 'center', className: 'st-col st-col-center' }, [
            h('div', { key: 'panel', className: 'st-panel' }, centerBody),
          ]),
          h('div', {
            key: 'split2',
            className: 'st-split',
            role: 'separator',
            'aria-orientation': 'vertical',
            onMouseDown: onSplitDown,
          }),
          h('div', { key: 'right', className: 'st-col st-col-right', style: { width: rightWidth } },
            h(StageChat, {
              sessionId,
              refreshKey,
              onSend: (text) => {
                if (sendPrompt) sendPrompt(text)
                setRefreshKey((key) => key + 1)
              },
            })),
        ]),
      ])
    }
    // ===== 设置页 =====

    /** 一个只读信息行。 */
    function InfoRow(props) {
      return h('div', { className: 'st-field-row' }, [
        h('span', { key: 'l', className: 'st-field-label' }, String((props && props.label) || '')),
        h('span', { key: 'v', className: 'st-field-value' }, String((props && props.value) || '—')),
      ])
    }

    /** 开关行。 */
    function ToggleRow(props) {
      const onChange = props && props.onChange
      return h('label', { className: 'st-field-row st-toggle-row' }, [
        h('span', { key: 'l', className: 'st-field-label' }, String((props && props.label) || '')),
        h('input', {
          key: 'i',
          type: 'checkbox',
          checked: Boolean(props && props.checked),
          disabled: Boolean(props && props.disabled),
          onChange: (event) => { if (onChange) onChange(event.target.checked) },
        }),
      ])
    }

    /**
     * 检查素材根目录是否可用，把结果写进 notice。
     *
     * 素材来自本机 Godot 项目的 UI 库；路径配错时图标会全部退回内联 SVG，
     * 界面上看不出错，所以给一个显式自检入口。
     * @param {(message: string) => void} setNotice - 结果回调。
     * @returns {void}
     */
    function probeAssets(setNotice) {
      requestJson('/assets').then((data) => {
        const detail = (data && data.detail) || {}
        const groups = Object.keys(detail)
        const missing = groups.filter((group) => {
          const dirs = detail[group] && Array.isArray(detail[group].dirs) ? detail[group].dirs : []
          return dirs.length > 0 && !dirs.some((entry) => entry && entry.exists)
        })
        if (missing.length) {
          setNotice('素材目录不完整：' + missing.join('、') + '（根目录 ' + String((data && data.root) || '?') + '）')
        } else {
          setNotice('素材目录正常：' + groups.length + ' 组，根目录 ' + String((data && data.root) || '?')
            + (data && data.prefix ? '，前缀 ' + String(data.prefix) : ''))
        }
      }).catch((error) => setNotice('素材检查失败：' + describeError(error)))
    }

    /**
     * 插件设置页（settings.section / plugins.bundle.config 共用）。
     *
     * 四块：数据与导入、界面偏好、引擎配置（只读）、素材自检。
     * 引擎配置来自 cordis.patch.yml，前端改不了也不该假装能改，所以只读展示并写明去哪改。
     * @returns {Object} React 元素。
     */
    function SettingsPanel() {
      const [ping, setPing] = useState(null)
      const [pingError, setPingError] = useState('')
      const [uiState, setUiState] = useState({})
      const [stRoot, setStRoot] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      const reload = useCallback(() => {
        api.ping().then((data) => { setPing(data || null); setPingError('') })
          .catch((error) => { setPingError(describeError(error)); setPing(null) })
        api.state().then((data) => { if (data && typeof data === 'object') setUiState(data) }).catch(() => {})
      }, [])

      useEffect(() => { reload() }, [reload])

      const saveUi = useCallback((patch) => {
        setUiState((current) => ({ ...current, ...patch }))
        api.saveState(patch).then(() => setNotice('已保存')).catch((error) => setNotice('保存失败：' + describeError(error)))
        window.setTimeout(() => setNotice(''), 1800)
      }, [])

      const doImport = useCallback(() => {
        const root = stRoot.trim()
        if (!root) { setNotice('请先填写 SillyTavern 安装目录'); return }
        setBusy(true)
        setNotice('正在导入…')
        api.importFrom(root, false).then((report) => {
          const data = report || {}
          setNotice('导入完成：角色 ' + (data.characters || 0) + '，世界书 ' + (data.worlds || 0) + '，预设 ' + (data.presets || 0))
          reload()
        }).catch((error) => {
          setNotice('导入失败：' + describeError(error))
        }).finally(() => setBusy(false))
      }, [stRoot, reload])

      // 这些是 cordis 配置（cordis.patch.yml），不是 UI 偏好：前端改不了也不该假装能改。
      // 有后端回显就显示真实值，没有就说清楚去哪改。
      const config = (ping && ping.config) || null
      const configRows = [
        { field: 'worldInfoBudget', label: '世界书令牌预算' },
        { field: 'maxWorldInfoDepth', label: '世界书递归深度' },
        { field: 'maxHistoryMessages', label: '历史消息条数' },
        { field: 'authorNoteDepth', label: '作者注释插入深度' },
        { field: 'defaultDiceSystem', label: '默认骰系' },
      ]

      return h('div', { className: 'st-settings' }, [
        h('div', { key: 'status', className: 'st-section-title' }, '数据'),
        pingError ? h('div', { key: 'err', className: 'st-notice st-warn' }, '接口不可用：' + pingError) : null,
        h('div', { key: 'rows', className: 'st-field-rows' }, [
          h(InfoRow, { key: 'root', label: '数据目录', value: ping && ping.dataRoot ? String(ping.dataRoot) : '（未知）' }),
          h(InfoRow, { key: 'ver', label: '插件版本', value: ping && ping.version ? String(ping.version) : '（未知）' }),
          h(InfoRow, {
            key: 'count',
            label: '已导入',
            value: ping ? ('角色 ' + (ping.characterCount || 0) + ' · 世界书 ' + (ping.worldbookCount || 0)) : '（未知）',
          }),
        ]),
        h('div', { key: 'import-head', className: 'st-section-title' }, '从 SillyTavern 导入'),
        h('div', { key: 'import', className: 'st-import' }, [
          h('input', {
            key: 'input',
            type: 'text',
            className: 'st-input',
            value: stRoot,
            placeholder: '例如 D:\Silly\SillyTavern-1.16.0',
            onChange: (event) => setStRoot(event.target.value),
          }),
          h('button', {
            key: 'btn',
            type: 'button',
            className: 'st-btn st-btn-primary',
            disabled: busy,
            onClick: doImport,
          }, busy ? '导入中…' : '开始导入'),
        ]),
        h('p', { key: 'hint', className: 'st-hint' },
          '只读取 ST 的 data/default-user 目录（角色卡 PNG/JSON、世界书、预设、快速回复、人格、正则），不改动原文件。'),
        h('div', { key: 'ui-head', className: 'st-section-title' }, '界面'),
        h('div', { key: 'ui', className: 'st-field-rows' }, [
          h(ToggleRow, {
            key: 'layout',
            label: '启用跑团三栏布局',
            checked: uiState.trpgLayout !== false,
            onChange: (value) => saveUi({ trpgLayout: value }),
          }),
          h('div', { key: 'panel', className: 'st-field-row' }, [
            h('span', { key: 'l', className: 'st-field-label' }, '中间默认面板'),
            h('select', {
              key: 's',
              className: 'st-input st-select',
              value: CENTER_PANELS.some((panel) => panel.id === uiState.centerPanel) ? uiState.centerPanel : 'map',
              onChange: (event) => saveUi({ centerPanel: event.target.value }),
            }, CENTER_PANELS.map((panel) => h('option', { key: panel.id, value: panel.id }, panel.label))),
          ]),
          h(ToggleRow, {
            key: 'left',
            label: '默认收起左栏',
            checked: Boolean(uiState.leftCollapsed),
            onChange: (value) => saveUi({ leftCollapsed: value }),
          }),
        ]),
        h('div', { key: 'cfg-head', className: 'st-section-title' }, '引擎配置（只读）'),
        h('div', { key: 'cfg', className: 'st-field-rows' }, configRows.map((item) => h(InfoRow, {
          key: item.field,
          label: item.label,
          value: config && config[item.field] !== undefined && config[item.field] !== null
            ? String(config[item.field])
            : '（后端未回显）',
        }))),
        h('p', { key: 'cfg-hint', className: 'st-hint' },
          '这些是插件配置，要在 cordis.patch.yml 的 dsh-sillytavern.config 下修改，改完重启 dsh web 生效。'),
        h('div', { key: 'assets-head', className: 'st-section-title' }, '素材'),
        h('div', { key: 'assets', className: 'st-assets' }, [
          h('span', { key: 'l', className: 'st-field-label' }, 'UI 图标 / 血条 / 面板'),
          h('button', {
            key: 'probe',
            type: 'button',
            className: 'st-btn',
            onClick: () => probeAssets(setNotice),
          }, '检查素材目录'),
        ]),
        notice ? h('div', { key: 'notice', className: 'st-notice' }, notice) : null,
      ])
    }

    // ===== 样式 =====
    //
    // 全部走 --dsw-* 主题令牌，不写死颜色；样式表打 data-plugin 归属标记，
    // 卸载时由 apply 里的 effect 移除（宿主会按模块 id 清理无主 style）。

    const CSS = [
      /* 气泡与 Markdown */
      '.st-bubble{display:flex;flex-direction:column;gap:6px;padding:10px 12px;margin:2px 0;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:1.62}',
      '.st-bubble-user{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--dsw-alias-border-l1))}',
      '.st-bubble-head{display:flex;align-items:center;gap:8px}',
      '.st-bubble-name{font-weight:600;font-size:13px;color:var(--dsw-alias-brand-primary)}',
      '.st-bubble-streaming{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.st-bubble-body{display:flex;flex-direction:column;gap:4px;word-break:break-word}',
      '.st-avatar{border-radius:50%;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-2);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}',
      '.st-avatar-fallback{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2))}',
      '.st-md-block{margin:0}',
      '.st-md-p{margin:0;white-space:pre-wrap}',
      '.st-md-heading{font-weight:700;margin:2px 0}',
      '.st-md-h1{font-size:19px}.st-md-h2{font-size:17px}.st-md-h3{font-size:15px}.st-md-h4,.st-md-h5,.st-md-h6{font-size:14px}',
      '.st-md-list{margin:2px 0;padding-left:20px}',
      '.st-md-quote{margin:2px 0;padding:2px 0 2px 10px;border-left:3px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.st-md-hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}',
      '.st-md-link{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.st-md-img{max-width:100%;border-radius:8px}',
      '.st-inline-code{padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Consolas,monospace;font-size:12.5px}',
      '.st-code-block{margin:4px 0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.5}',
      '.st-code-block[data-open]{border-style:dashed}',
      '.st-side-note{color:var(--dsw-alias-label-secondary);font-style:italic;opacity:.86}',
      '.st-muted{color:var(--dsw-alias-label-secondary)}',
      '.st-warn{color:var(--dsw-alias-brand-primary)}',
      /* 世界书角标 */
      '.st-wi{display:flex;flex-direction:column;gap:4px;align-items:flex-start}',
      '.st-wi-toggle{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}',
      '.st-wi-toggle:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.st-wi.is-open .st-wi-caret{transform:rotate(90deg)}',
      '.st-wi-caret{transition:transform .15s ease}',
      '.st-wi-list{margin:0;padding:6px 10px 6px 22px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto}',
      /* 选项按钮 */
      '.st-choices{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
      '.st-choice{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
      '.st-choice:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);border-color:var(--dsw-alias-brand-primary)}',
      '.st-choice:disabled{opacity:.5;cursor:default}',
      '.st-choice-index{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;font-weight:700}',
      /* 通用控件 */
      '.st-btn{padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease}',
      '.st-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.st-btn:disabled{opacity:.5;cursor:default}',
      '.st-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground)}',
      '.st-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.st-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.st-input{padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;font-family:inherit}',
      '.st-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.st-select{min-width:120px}',
      '.st-icon{flex:none;display:inline-block;vertical-align:middle}',
      '.st-glyph{flex:none;object-fit:contain;image-rendering:pixelated;vertical-align:middle}',
      '.st-section-title{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px}',
      '.st-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:160px;padding:24px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center}',
      /* 跑团浮层 */
      '.st-stage{position:fixed;inset:0;z-index:2147482000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.st-stage-top{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}',
      '.st-stage-title{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:13.5px;letter-spacing:.02em}',
      '.st-stage-chip{padding:2px 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:11.5px}',
      '.st-stage-spacer{flex:1 1 auto}',
      '.st-stage-error{padding:6px 14px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:12.5px;flex:none}',
      '.st-stage-body{flex:1 1 auto;display:flex;min-height:0}',
      '.st-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.st-col-left{flex:0 0 auto;width:280px;min-width:180px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.st-col-left.is-collapsed{width:44px}',
      '.st-col-center{flex:1 1 0%;min-width:240px;background:var(--dsw-alias-bg-base);overflow:hidden}',
      '.st-col-right{flex:0 0 auto;min-width:260px;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.st-panels{display:flex;flex-direction:column;gap:12px;padding:12px;overflow:auto;height:100%}',
      '.st-panel-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.st-panel-head{display:flex;align-items:baseline;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.st-panel-title{font-weight:600;font-size:13px}',
      '.st-panel-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.st-panel-body{padding:10px 12px}',
      '.st-panel-blocks{display:flex;flex-direction:column;gap:10px}',
      '.st-blk-heading{margin:0;font-size:13px;font-weight:600}',
      '.st-blk-text{margin:0;font-size:13px;line-height:1.65}',
      '.st-blk-quote{margin:0;padding-left:10px;border-left:2px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary)}',
      '.st-blk-divider{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:2px 0}',
      '.st-blk-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.st-blk-list ul{margin:0;padding-left:18px;font-size:13px;line-height:1.7}',
      '.st-chip-row{display:flex;flex-wrap:wrap;gap:6px}',
      '.st-meter-head{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}',
      '.st-meter-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.st-meter-track{height:8px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}',
      '.st-meter-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .2s ease}',
      '.st-meter-fill.is-danger{background:var(--dsw-alias-label-primary)}.st-meter-fill.is-warn{background:var(--dsw-alias-label-primary)}.st-meter-fill.is-ok{background:var(--dsw-alias-label-primary)}',
      '.st-blk-table table,.st-panel-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.st-blk-table th,.st-blk-table td,.st-panel-table th,.st-panel-table td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.st-blk-steps{margin:0;padding-left:18px;font-size:13px;line-height:1.7}',
      '.st-blk-image img{max-width:100%;border-radius:8px;display:block}',
      '.st-panel-img{max-width:100%;border-radius:8px;display:block}',
      '.st-panel-canvas{width:100%;border:0;border-radius:8px;background:var(--dsw-alias-bg-base)}',
      '.st-stage-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;color:var(--dsw-alias-label-secondary);text-align:center;padding:24px}',
      '.st-stage-empty p{margin:0;font-size:13px}',
      '.st-stage-lobby .st-stage-top{border-bottom:none}',
      '.st-lobby-wrap{flex:1;min-height:0;overflow:auto;padding:24px 32px}',
      '.st-lobby-head{max-width:900px;margin:0 auto 18px}',
      '.st-lobby-head h2{margin:0 0 6px;font-size:18px;font-weight:600}',
      '.st-lobby-head p{margin:0 0 14px;font-size:13px}',
      '.st-lobby-search{width:100%;max-width:420px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
      '.st-lobby-search:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.st-lobby-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;max-width:1100px;margin:0 auto}',
      '.st-lobby-card{display:flex;gap:12px;align-items:center;text-align:left;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .12s ease,transform .12s ease}',
      '.st-lobby-card:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px)}',
      '.st-lobby-card:disabled{opacity:.5;cursor:default}',
      '.st-lobby-avatar{flex:none}',
      '.st-lobby-body{min-width:0}',
      '.st-lobby-name{font-size:14px;font-weight:600;margin-bottom:3px}',
      '.st-lobby-desc{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.st-lobby-tag{display:inline-block;margin-top:5px;padding:1px 7px;border-radius:999px;font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.st-lobby-empty{text-align:center;padding:60px 20px;color:var(--dsw-alias-label-secondary)}',
      '.st-topbar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}',
      '.st-topbar-who{display:flex;align-items:center;gap:8px;min-width:0}',
      '.st-topbar-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.st-topbar-wb{position:relative}',
      '.st-topbar-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
      '.st-topbar-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.st-topbar-btn.is-open{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.st-topbar-spacer{flex:1}',
      '.st-topbar-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:40;min-width:260px;max-height:320px;overflow:auto;padding:6px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)}',
      '.st-topbar-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:12px;cursor:pointer}',
      '.st-topbar-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.st-topbar-empty{padding:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.st-stage-top-hidden{display:none}',
      '.st-split{flex:none;width:6px;cursor:col-resize;background:transparent;transition:background .12s ease}',
      '.st-split:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}',
      '.st-tabs{display:flex;gap:2px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}',
      '.st-tab{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.st-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.st-tab.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.st-panel{flex:1 1 auto;min-height:0;overflow:auto;padding:12px}',
      /* 左栏 */
      '.st-aside{display:flex;flex-direction:column;gap:2px;height:100%;padding:8px 6px;overflow:auto}',
      '.st-aside-collapsed{display:flex;align-items:flex-start;justify-content:center;height:100%;padding-top:10px}',
      '.st-aside-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 4px 2px}',
      '.st-aside-title{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.05em}',
      '.st-aside-list{display:flex;flex-direction:column;gap:1px;margin-bottom:8px}',
      '.st-aside-row{display:flex;align-items:center;gap:7px;width:100%;padding:4px 7px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;text-align:left;cursor:pointer}',
      '.st-aside-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.st-aside-row.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.st-aside-toggle{cursor:pointer}',
      '.st-aside-toggle input{accent-color:var(--dsw-alias-brand-primary);flex:none;margin:0}',
      '.st-aside-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.st-aside-count{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.st-aside-empty{padding:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      /* 地图 */
      '.st-map{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0}',
      '.st-map-bar{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.st-map-name{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.st-map-empty-hint{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}',
      '.st-map-stage{flex:1 1 auto;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:4px}',
      '.st-map-svg{border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);max-width:100%;height:auto;flex:none}',
      '.st-tile-floor{fill:var(--dsw-alias-bg-layer-1)}',
      '.st-tile-wall{fill:color-mix(in srgb,var(--dsw-alias-label-primary) 74%,var(--dsw-alias-bg-base))}',
      '.st-tile-door{fill:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-bg-layer-1))}',
      '.st-tile-water{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,var(--dsw-alias-bg-layer-1))}',
      '.st-tile-grass{fill:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,var(--dsw-alias-bg-layer-1))}',
      '.st-tile-stone{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 34%,var(--dsw-alias-bg-layer-1))}',
      '.st-tile-void{fill:var(--dsw-alias-bg-base)}',
      '.st-tile-fog{fill:var(--dsw-alias-bg-base);opacity:.82;pointer-events:none}',
      '.st-grid-line{stroke:var(--dsw-alias-border-l1);stroke-width:1;fill:none;opacity:.55;pointer-events:none}',
      '.st-feature circle{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-brand-primary);stroke-width:1.5}',
      '.st-feature-mark{fill:var(--dsw-alias-brand-primary);pointer-events:none;user-select:none}',
      '.st-tile-icon,.st-feature-icon,.st-token-icon{pointer-events:none;image-rendering:pixelated}',
      '.st-token{cursor:pointer}',
      '.st-token-disc{fill:var(--dsw-alias-brand-primary);stroke:var(--dsw-alias-bg-base);stroke-width:2}',
      '.st-token-label{fill:var(--dsw-alias-label-primary-foreground);font-weight:700;pointer-events:none;user-select:none}',
      '.st-token.is-active .st-token-disc{stroke:var(--dsw-alias-label-primary);stroke-width:3}',
      '.st-token-detail{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.st-token-detail-info{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;font-size:12.5px;min-width:0}',
      /* 角色卡 */
      '.st-sheets{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0}',
      '.st-sheet-tabs{display:flex;gap:4px;flex-wrap:wrap;flex:none}',
      '.st-sheet-tab{padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
      '.st-sheet-tab.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.st-sheet{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow:auto;min-height:0}',
      '.st-sheet-head{display:flex;align-items:center;gap:10px}',
      '.st-sheet-id{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}',
      '.st-sheet-id strong{font-size:14px}',
      '.st-ac{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;font-weight:600}',
      '.st-sheet-vitals{display:flex;flex-direction:column;gap:6px}',
      '.st-vital{display:flex;align-items:center;gap:8px}',
      '.st-vital-label{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary);width:52px;flex:none}',
      '.st-statbar{position:relative;flex:1 1 auto;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.st-statbar-track{position:absolute;inset:0}',
      '.st-statbar-fill{height:100%;border-radius:999px;transition:width .2s ease}',
      '.st-statbar-health .st-statbar-fill{background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-error-primary) 82%,transparent),color-mix(in srgb,var(--dsw-alias-state-error-primary) 52%,transparent))}',
      '.st-statbar-mana .st-statbar-fill{background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,transparent),color-mix(in srgb,var(--dsw-alias-state-business-primary) 52%,transparent))}',
      '.st-statbar-shield .st-statbar-fill{background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 78%,transparent),color-mix(in srgb,var(--dsw-alias-state-warn-primary) 46%,transparent))}',
      '.st-statbar.has-tex .st-statbar-track{display:flex}',
      '.st-statbar-tex{position:absolute;left:2px;top:50%;transform:translateY(-50%);opacity:.9;pointer-events:none;height:calc(100% - 2px);width:auto;object-fit:contain}',
      '.st-statbar.has-tex .st-statbar-text{justify-content:flex-end;padding-right:8px}',
      '.st-statbar-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);text-shadow:0 1px 2px var(--dsw-alias-bg-base)}',
      '.st-attr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px}',
      '.st-attr{display:grid;grid-template-columns:auto auto;grid-template-rows:auto auto;align-items:center;gap:0 5px;padding:6px 8px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.st-attr-value{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.st-attr-label{grid-column:1 / -1;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.st-status-row{display:flex;flex-wrap:wrap;gap:4px}',
      '.st-status-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.st-items{display:flex;flex-direction:column;gap:4px}',
      '.st-item-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}',
      '.st-item-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:12px}',
      '.st-item-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.st-item-qty{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.st-sheet-notes{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}',
      /* 场景 */
      '.st-scene{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;overflow:auto}',
      '.st-scene-image{display:block;width:100%;min-height:220px;max-height:56vh;flex:none;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);object-fit:cover;background-color:var(--dsw-alias-bg-layer-1)}',
      '.st-scene-placeholder{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}',
      '.st-scene-body{display:flex;flex-direction:column;gap:6px}',
      '.st-scene-title{margin:0;font-size:16px;font-weight:600}',
      '.st-scene-meta{display:flex;flex-wrap:wrap;gap:5px}',
      '.st-scene-text{font-size:13.5px;line-height:1.65}',
      /* 日志 */
      '.st-log{display:flex;flex-direction:column;gap:3px;height:100%;overflow:auto;padding-right:4px}',
      '.st-log-row{display:flex;align-items:baseline;gap:8px;padding:5px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:12.5px}',
      '.st-log-kind{flex:none;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.st-log-title{flex:1 1 auto;min-width:0}',
      '.st-log-detail{flex:none;color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      '.st-log-total{flex:none;font-weight:700;font-variant-numeric:tabular-nums;padding:0 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}',
      '.st-log-roll .st-log-kind,.st-log-check .st-log-kind{color:var(--dsw-alias-brand-primary)}',
      '.st-log-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 52%,var(--dsw-alias-border-l1))}',
      '.st-log-ok .st-log-total{color:var(--dsw-alias-state-success-primary)}',
      '.st-log-bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 52%,var(--dsw-alias-border-l1))}',
      '.st-log-bad .st-log-total{color:var(--dsw-alias-state-error-primary)}',
      /* 右栏对话 */
      '.st-chat{display:flex;flex-direction:column;height:100%;min-height:0}',
      '.st-chat-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:10px}',
      '.st-chat-hint{padding:14px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.st-chat-composer{flex:none;display:flex;gap:8px;align-items:flex-end;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.st-chat-input{flex:1 1 auto;min-height:40px;max-height:140px;resize:vertical;padding:7px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;line-height:1.5;outline:none}',
      '.st-chat-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.st-chat-send{flex:none;height:34px}',
      /* 对话接管：原生外观兜底 + 思考折叠 + 流式光标 */
      '.st-native{display:flex;flex-direction:column;gap:6px;font-size:13.5px;line-height:1.62;color:var(--dsw-alias-label-primary)}',
      '.st-native-text{word-break:break-word}',
      '.st-reasoning{display:flex;flex-direction:column;gap:4px;border-left:2px solid var(--dsw-alias-border-l1);padding-left:8px}',
      '.st-reasoning-toggle{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;font-family:inherit}',
      '.st-reasoning-toggle:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.st-reasoning.is-open .st-wi-caret{transform:rotate(90deg)}',
      '.st-reasoning-body{white-space:pre-wrap;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-height:320px;overflow:auto}',
      '.st-cursor{display:inline-block;width:7px;height:14px;border-radius:2px;background:var(--dsw-alias-brand-primary);animation:st-blink 1s steps(2,start) infinite;vertical-align:-2px}',
      '@keyframes st-blink{0%,100%{opacity:1}50%{opacity:.15}}',
      '.st-stopped{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-style:italic}',
      '.st-trpg-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;flex:none}',
      /* 设置页 */
      '.st-settings{display:flex;flex-direction:column;gap:2px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.st-field-rows{display:flex;flex-direction:column;gap:4px}',
      '.st-field-row{display:flex;align-items:center;gap:10px;padding:5px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
      '.st-field-label{flex:1 1 auto;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.st-field-value{flex:none;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-variant-numeric:tabular-nums}',
      '.st-toggle-row{cursor:pointer}',
      '.st-toggle-row input{accent-color:var(--dsw-alias-brand-primary)}',
      '.st-import{display:flex;gap:8px;align-items:center}',
      '.st-import .st-input{flex:1 1 auto}',
      '.st-assets{display:flex;gap:10px;align-items:center;padding:5px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
      '.st-assets .st-field-label{flex:1 1 auto}',
      '.st-hint{margin:6px 0 0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      '.st-notice{margin-top:10px;padding:7px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '@media (max-width:900px){.st-col-left:not(.is-collapsed){width:190px!important}.st-col-right{min-width:240px}}',
    ].join('')

    /**
     * 建一个归属本插件的 style 标签。
     *
     * 宿主的客户端模块系统会把「无主 style」认到当时物化的模块名下，
     * 那个模块一变更就整套样式消失；打上 data-plugin 预标记就不会被认领。
     * @param {string} css - 样式文本。
     * @returns {HTMLStyleElement} 已挂到 head 的元素。
     */
    function createOwnedStyle(css) {
      const el = document.createElement('style')
      el.setAttribute('data-plugin', PLUGIN_ID)
      el.textContent = css
      document.head.appendChild(el)
      return el
    }

    // ===== 对话渲染接管 =====
    //
    // 宿主是「按键整行替换」：keyed 槽一旦有人占了 assistant-step，ui-chat 原来的
    // 渲染器就不再出现，返回 null 只会得到空行（不是回退）。所以这里必须自带一套
    // 完整渲染（正文 / 思考 / 流式状态），不能指望回退。
    // 跑团三栏里的对话始终用酒馆气泡，不受这里影响。

    /**
     * 从 DSH chat node 里抽酒馆字段。
     *
     * 宿主投影出的节点没有任意 extra 字段，所以取的是我们自己的投影：
     * node.data.extra 或 node.data.tavern。都没有就返回 null。
     * @param {any} node - conversation.chat.node 的 node 参数。
     * @returns {null | { role: string, name: string, text: string, extra: any, streaming: boolean, avatar: string }}
     */
    function readTavernNode(node) {
      if (!node || typeof node !== 'object') return null
      const data = node.data && typeof node.data === 'object' ? node.data : null
      if (!data) return null
      const extra = data.extra && typeof data.extra === 'object' ? data.extra : null
      const tavern = data.tavern && typeof data.tavern === 'object' ? data.tavern : null
      const meta = tavern || extra
      if (!meta) return null
      const blocks = Array.isArray(data.blocks) ? data.blocks : null
      const text = blocks
        ? blocks.filter((block) => block && block.kind === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
        : (typeof data.text === 'string' ? data.text : '')
      return {
        role: meta.role === 'user' ? 'user' : 'assistant',
        name: String(meta.name || meta.characterName || ''),
        text,
        extra: meta,
        streaming: data.status === 'running',
        avatar: typeof meta.avatarUrl === 'string' ? meta.avatarUrl : '',
      }
    }

    /**
     * 思考块折叠行（接管渲染时用）。
     * @param {{ text: string, running: boolean }} props
     * @returns {Object|null} React 元素；空文本返回 null。
     */
    function ReasoningFold(props) {
      const [open, setOpen] = useState(false)
      const text = String((props && props.text) || '')
      if (!text.trim()) return null
      return h('div', { className: 'st-reasoning' + (open ? ' is-open' : '') }, [
        h('button', {
          key: 't',
          type: 'button',
          className: 'st-reasoning-toggle',
          onClick: () => setOpen(value => !value),
          'aria-expanded': open,
        }, [
          h(Icon, { key: 'i', name: 'chevron', size: 11, className: 'st-wi-caret' }),
          props && props.running ? '思考中…' : '思考过程',
        ]),
        open ? h('div', { key: 'b', className: 'st-reasoning-body' }, text) : null,
      ])
    }

    /**
     * 接管 conversation.chat.node 的 assistant 渲染器。
     *
     * 有酒馆数据时渲染角色气泡；否则按原生外观渲染正文与思考块，
     * 保证接管后普通 DSH 对话依然完整可读（工具调用行由宿主分组，不经过这里）。
     * @param {{ node?: any, sendPrompt?: (text: string) => void }} props
     * @returns {Object|null} React 元素。
     */
    function TavernAssistantView(props) {
      const node = props && props.node
      const parsed = readTavernNode(node)
      if (parsed) {
        return h(TavernBubble, {
          role: parsed.role,
          name: parsed.name || '酒馆',
          avatar: parsed.avatar,
          text: parsed.text,
          extra: parsed.extra,
          streaming: parsed.streaming,
          onPickChoice: props && props.sendPrompt,
        })
      }
      const data = node && node.data && typeof node.data === 'object' ? node.data : null
      if (!data) return null
      const blocks = Array.isArray(data.blocks) ? data.blocks : []
      const streaming = data.status === 'running'
      const interrupted = data.status === 'interrupted'
      const rendered = []
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (!block || typeof block !== 'object') continue
        if (block.kind === 'text') {
          rendered.push(h('div', { key: 'b' + index, className: 'st-native-text' },
            renderMarkdown(block.text, { keyPrefix: 'a' + index, streaming })))
        } else if (block.kind === 'reasoning') {
          rendered.push(h(ReasoningFold, { key: 'r' + index, text: block.text, running: streaming }))
        }
        // tool-call / image 块由宿主其它槽负责，跳过（与原生 AssistantMarkdown 一致）
      }
      if (!streaming && !interrupted && !rendered.length) return null
      return h('div', { className: 'st-native', 'data-streaming': streaming || undefined }, [
        ...rendered,
        streaming ? h('span', { key: 'cur', className: 'st-cursor' }) : null,
        interrupted ? h('span', { key: 'stop', className: 'st-stopped' }, '已停止') : null,
      ])
    }



    // ===== 酒馆模式三段式：Lobby → 顶部横幅 → 精简左栏 =====

    /**
     * 进入酒馆模式前的模组选择界面。
     *
     * 用户要求：先选模组再进去，进来以后左侧不要多余内容。
     * 所以这一步只呈现角色卡（= 一个故事/模组），别的什么都不显示。
     * @param {{ characters: Array, onPick: (id: string) => void, busy: boolean }} props
     * @returns {Object} React 元素
     */
    function TavernLobby(props) {
      const characters = (props && props.characters) || []
      const busy = Boolean(props && props.busy)
      const [filter, setFilter] = useState('')
      const shown = useMemo(() => {
        const q = String(filter || '').trim().toLowerCase()
        if (!q) return characters
        return characters.filter((c) => {
          const hay = (String(c.name || '') + ' ' + String(c.description || '') + ' ' + (Array.isArray(c.tags) ? c.tags.join(' ') : '')).toLowerCase()
          return hay.includes(q)
        })
      }, [characters, filter])
      return h('div', { className: 'st-lobby' }, [
        h('div', { key: 'head', className: 'st-lobby-head' }, [
          h('h2', { key: 't' }, '选择模组'),
          h('p', { key: 'd', className: 'st-muted' }, '每个角色卡是一个故事。选定之后，它的开场白、世界书和设定会一起载入。'),
          h('input', {
            key: 'q',
            className: 'st-lobby-search',
            type: 'search',
            placeholder: '搜索角色 / 标签…',
            value: filter,
            onInput: (e) => setFilter(e.target.value),
          }),
        ]),
        characters.length === 0
          ? h('div', { key: 'empty', className: 'st-lobby-empty' }, '还没有角色卡。先在设置里从 SillyTavern 导入。')
          : h('div', { key: 'grid', className: 'st-lobby-grid' }, shown.map((c) => h('button', {
            key: String(c.id || c.name),
            type: 'button',
            className: 'st-lobby-card',
            disabled: busy,
            onClick: () => { if (props && props.onPick) props.onPick(String(c.id || c.name)) },
          }, [
            h('div', { key: 'av', className: 'st-lobby-avatar' }, h(Avatar, {
              src: avatarUrlOf(c), name: c.name, size: 56,
            })),
            h('div', { key: 'b', className: 'st-lobby-body' }, [
              h('div', { key: 'n', className: 'st-lobby-name' }, String(c.name || '未命名')),
              c.description ? h('div', { key: 'd', className: 'st-lobby-desc' }, String(c.description).slice(0, 90)) : null,
              c.hasBook ? h('div', { key: 'bk', className: 'st-lobby-tag' }, '含世界书') : null,
            ]),
          ]))),
      ])
    }

    /**
     * 进入后的顶部横幅：世界书开关、当前角色、舞台入口。
     *
     * 用户要求：世界书开关放上方横幅，完全按 ST 的心智模型
     * （角色卡是主体，世界书是它的附属开关）。
     * @param {{ character: Object|null, worldbooks: Array, onToggleWorldbook: Function, onExit: Function, stageOpen: boolean, onToggleStage: Function }} props
     * @returns {Object} React 元素
     */
    function TavernTopBar(props) {
      const character = props && props.character
      const worldbooks = (props && props.worldbooks) || []
      const enabled = worldbooks.filter((b) => b.enabled).length
      const [openBooks, setOpenBooks] = useState(false)
      return h('div', { className: 'st-topbar' }, [
        h('div', { key: 'who', className: 'st-topbar-who' }, [
          character ? h(Avatar, { key: 'a', src: avatarUrlOf(character), name: character.name, size: 22 }) : null,
          h('span', { key: 'n', className: 'st-topbar-name' }, character ? String(character.name) : '未选择角色'),
        ]),
        h('div', { key: 'wb', className: 'st-topbar-wb' }, [
          h('button', {
            key: 'btn',
            type: 'button',
            className: 'st-topbar-btn' + (openBooks ? ' is-open' : ''),
            onClick: () => setOpenBooks((v) => !v),
            title: '世界书开关',
          }, [h(Icon, { key: 'i', name: 'book', size: 13 }), '世界书 ' + enabled + '/' + worldbooks.length]),
          openBooks ? h('div', { key: 'menu', className: 'st-topbar-menu' }, worldbooks.length
            ? worldbooks.map((book) => h('label', { key: String(book.name), className: 'st-topbar-item' }, [
              h('input', {
                key: 'c',
                type: 'checkbox',
                checked: Boolean(book.enabled),
                onChange: (e) => { if (props && props.onToggleWorldbook) props.onToggleWorldbook(String(book.name), e.target.checked) },
              }),
              h('span', { key: 'n' }, String(book.name)),
              h('span', { key: 'c', className: 'st-muted' }, book.entries === undefined ? '' : String(book.entries)),
            ]))
            : h('div', { key: 'e', className: 'st-topbar-empty' }, '没有可用的世界书')) : null,
        ]),
        h('div', { key: 'sp', className: 'st-topbar-spacer' }),
        h('button', {
          key: 'stage',
          type: 'button',
          className: 'st-topbar-btn' + (props && props.stageOpen ? ' is-open' : ''),
          onClick: () => { if (props && props.onToggleStage) props.onToggleStage() },
          title: '打开/收起舞台',
        }, [h(Icon, { key: 'i', name: 'layers', size: 13 }), '舞台']),
        h('button', {
          key: 'exit',
          type: 'button',
          className: 'st-topbar-btn',
          onClick: () => { if (props && props.onExit) props.onExit() },
          title: '换一个模组',
        }, '换模组'),
      ])
    }
    // ===== 通用舞台面板（AI 决定内容与形状） =====

    /**
     * 渲染一个舞台块。块是模型给的通用积木，不预设玩法。
     * @param {{ block: Object }} props
     * @returns {Object|null}
     */
    function StageBlock(props) {
      const block = props && props.block
      if (!block || !block.kind) return null
      const kind = block.kind
      if (kind === 'heading') return h('h4', { className: 'st-blk-heading' }, String(block.text || block.title || ''))
      if (kind === 'text') return h('p', { className: 'st-blk-text' }, String(block.text || ''))
      if (kind === 'quote') return h('blockquote', { className: 'st-blk-quote' }, String(block.text || ''))
      if (kind === 'divider') return h('hr', { className: 'st-blk-divider' })
      if (kind === 'list') {
        const items = Array.isArray(block.items) ? block.items : []
        return h('div', { className: 'st-blk-list' }, [
          block.label ? h('div', { key: 'l', className: 'st-blk-label' }, String(block.label)) : null,
          h('ul', { key: 'u' }, items.map((item, i) => h('li', { key: 'i' + i },
            typeof item === 'string' ? item : String(item && (item.text || item.name) || '')))),
        ])
      }
      if (kind === 'chips') {
        const items = Array.isArray(block.items) ? block.items : []
        return h('div', { className: 'st-blk-chips' }, [
          block.label ? h('div', { key: 'l', className: 'st-blk-label' }, String(block.label)) : null,
          h('div', { key: 'c', className: 'st-chip-row' }, items.map((item, i) => h('span', {
            key: 'i' + i,
            className: 'st-status-chip',
          }, typeof item === 'string' ? item : String(item && (item.text || item.name) || '')))),
        ])
      }
      if (kind === 'meter') {
        const max = Number(block.max) > 0 ? Number(block.max) : 0
        const value = Number(block.value)
        const pct = max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
        return h('div', { className: 'st-blk-meter' }, [
          h('div', { key: 'h', className: 'st-meter-head' }, [
            h('span', { key: 'l' }, String(block.label || '')),
            h('span', { key: 'v', className: 'st-meter-value' },
              (Number.isFinite(value) ? String(value) : '-') + (max > 0 ? ' / ' + max : '') + (block.unit ? ' ' + block.unit : '')),
          ]),
          h('div', { key: 't', className: 'st-meter-track' }, h('div', {
            key: 'f',
            className: 'st-meter-fill' + (block.tone ? ' is-' + block.tone : ''),
            style: { width: pct.toFixed(1) + '%' },
          })),
        ])
      }
      if (kind === 'table') {
        const columns = Array.isArray(block.columns) ? block.columns : []
        const rows = Array.isArray(block.rows) ? block.rows : []
        return h('div', { className: 'st-blk-table' }, [
          block.label ? h('div', { key: 'l', className: 'st-blk-label' }, String(block.label)) : null,
          h('table', { key: 't' }, [
            h('thead', { key: 'h' }, h('tr', {}, columns.map((col, i) => h('th', { key: i }, String(col.label || col.key || ''))))),
            h('tbody', { key: 'b' }, rows.map((row, ri) => h('tr', { key: ri },
              columns.map((col, ci) => h('td', { key: ci }, String(row && row[col.key] !== undefined ? row[col.key] : '')))))),
          ]),
        ])
      }
      if (kind === 'steps') {
        const items = Array.isArray(block.items) ? block.items : []
        return h('ol', { className: 'st-blk-steps' }, items.map((item, i) => h('li', { key: i },
          typeof item === 'string' ? item : String(item && (item.text || item.title) || ''))))
      }
      if (kind === 'image') {
        return h('figure', { className: 'st-blk-image' }, [
          h('img', { key: 'i', src: String(block.src || ''), alt: String(block.label || '') }),
          block.label ? h('figcaption', { key: 'c' }, String(block.label)) : null,
        ])
      }
      return null
    }

    /**
     * 渲染一个舞台面板。面板种类由模型选，这里只负责把它画出来。
     * @param {{ panel: Object }} props
     * @returns {Object|null}
     */
    function StagePanel(props) {
      const panel = props && props.panel
      if (!panel || !panel.id) return null
      const kind = panel.kind
      let body = null

      if (kind === 'blocks') {
        const blocks = Array.isArray(panel.blocks) ? panel.blocks : []
        body = blocks.length
          ? h('div', { className: 'st-panel-blocks' }, blocks.map((block) => h(StageBlock, { key: block.id, block })))
          : h('p', { className: 'st-muted' }, '（空）')
      } else if (kind === 'text') {
        body = h('p', { className: 'st-panel-text' }, String(panel.text || ''))
      } else if (kind === 'image') {
        body = h('img', { className: 'st-panel-img', src: String(panel.src || ''), alt: String(panel.title || '') })
      } else if (kind === 'table') {
        const columns = Array.isArray(panel.columns) ? panel.columns : []
        const rows = Array.isArray(panel.rows) ? panel.rows : []
        body = h('table', { className: 'st-panel-table' }, [
          h('thead', { key: 'h' }, h('tr', {}, columns.map((col, i) => h('th', { key: i }, String(col.label || col.key || ''))))),
          h('tbody', { key: 'b' }, rows.map((row, ri) => h('tr', { key: ri },
            columns.map((col, ci) => h('td', { key: ci }, String(row && row[col.key] !== undefined ? row[col.key] : '')))))),
        ])
      } else if (kind === 'canvas') {
        // 模型给的 HTML 用 srcdoc 隔离，脚本不执行（舞台只做展示）
        body = h('iframe', {
          className: 'st-panel-canvas',
          sandbox: '',
          srcDoc: '<!doctype html><meta charset=utf-8><style>' + String(panel.css || '') + 'body{margin:0;font:13px system-ui;color:var(--dsw-alias-label-primary)}</style>' + String(panel.html || ''),
          style: { height: (Number(panel.height) > 0 ? Number(panel.height) : 260) + 'px' },
        })
      } else if (kind === 'map') {
        body = h(MapCanvas, { raw: panel.map })
      } else {
        body = h('p', { className: 'st-muted' }, '不支持的面板类型：' + String(kind))
      }

      return h('section', { className: 'st-panel-card', 'data-panel': panel.id }, [
        panel.title ? h('header', { key: 'h', className: 'st-panel-head' }, [
          h('span', { key: 't', className: 'st-panel-title' }, String(panel.title)),
          panel.subtitle ? h('span', { key: 's', className: 'st-panel-sub' }, String(panel.subtitle)) : null,
        ]) : null,
        h('div', { key: 'b', className: 'st-panel-body' }, body),
      ])
    }
    // ===== 运行期装配 =====

    const inject = ['slots', 'sessions', 'conversation']

    /**
     * 插件客户端入口。
     *
     * 注册：跑团浮层（turnTail）、输入框「跑团」按钮、设置页分区、插件配置页、
     * 以及对话渲染接管。所有注册都由 slots.inject 托管，卸载随插件 fiber 回收。
     * @param {any} ctx - cordis 客户端上下文，必须有 slots 服务。
     * @returns {void}
     */
    function apply(ctx) {
      if (!ctx || !ctx.slots) return
      const slots = ctx.slots

      // 样式：先注入再注册组件，避免首帧无样式闪一下。
      const styleEl = createOwnedStyle(CSS)
      ctx.effect(() => () => { styleEl.remove() }, PLUGIN_ID + ': styles')

      // 三栏浮层开关：turnTail 与 input.left 两个入口共享同一份状态。
      const stage = createStageController()

      /**
       * 生成把文本发进当前会话的函数。
       * @param {string} sessionId - 宿主按会话作用域传入的会话 id。
       * @returns {(text: string) => void} 发送函数；上下文缺失时静默不做事。
       */
      // 发送能力由 slot 的 inject 面提供（宿主按会话作用域注入 sendPrompt）。
      // 这里不再走 ctx.sessions.scope(id).get('conversation') —— 那个 scope 的 get
      // 要求先 declare inject，否则抛 "cannot get property … without inject"，
      // 而这个异常会打断整棵组件树（三栏直接渲染不出来）。
      const makeSender = () => undefined

      // 1) 跑团浮层：挂在输入区 overlay 上。
      //    不能挂 conversation.chat.turnTail —— 那是每轮末尾才出现的挂载点，
      //    新会话还没有任何消息时它不存在，浮层就不会渲染（点「跑团」没反应）。
      //    输入区 overlay 常驻；浮层本体 position:fixed，位置不依赖挂载点。
      slots.inject('conversation.input.overlay', () => slots.register({
        name: 'conversation.input.overlay',
        id: PLUGIN_ID + ':stage',
        order: 50,
        inject: (sessionId) => ({ sessionId: String(sessionId || ''), sendPrompt: () => {} }),
      }, (props) => h(TrpgOverlay, {
        open: useSnapshot(stage).open === true,
        onClose: stage.close,
        sessionId: props && props.sessionId ? String(props.sessionId) : '',
        sendPrompt: props && props.sendPrompt,
      })))

      // 2) 输入框左侧的「跑团」按钮。
      slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left',
        id: PLUGIN_ID + ':trpg-toggle',
        order: 30,
        label: '跑团模式',
      }, () => h('button', {
        type: 'button',
        className: 'st-btn st-btn-primary st-trpg-btn',
        title: '打开三栏跑团模式（地图 / 场景 / 角色卡 / 日志）',
        onClick: () => stage.toggle(),
      }, [h(Icon, { key: 'i', name: 'dice', size: 14 }), '跑团'])))

      // 3) 设置页分区 + 插件配置页（同一份内容，两个入口都放，免得用户找不到）。
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: PLUGIN_ID,
        order: 60,
        label: '酒馆 / 跑团',
      }, () => h(SettingsPanel, {})))
      slots.inject('plugins.bundle.config', () => slots.register({
        name: 'plugins.bundle.config',
        key: PLUGIN_ID,
      }, () => h(SettingsPanel, {})))

      // 4) 不再接管 conversation.chat.node。
      //    那是 keyed 替换槽，会和宿主渲染器在同一轮结束时同时命中，导致回复重复一遍。
      //    酒馆气泡改由三栏浮层右栏自己渲染（那份数据走 HTTP，和宿主渲染互不干扰）。
    }

    exports.apply = apply
    exports.inject = inject
    // 仅回归测试（scripts/verify-client.mjs）使用；宿主不消费。
    exports.__test = {
      renderMarkdown,
      parseInline,
      buildListTree,
      renderListLevel,
      extractChoices,
      readActivatedWorldInfo,
      normalizeMap,
      clampInt,
      buildBlankMap,
      terrainClass,
      readTavernNode,
      avatarUrlOf,
      assetUrl,
      requestJson,
      ICON_PATHS,
      CENTER_PANELS,
      ATTRIBUTE_LABELS,
      DEFAULT_LAYOUT,
      CSS,
    }

    return module.exports
  },
})
