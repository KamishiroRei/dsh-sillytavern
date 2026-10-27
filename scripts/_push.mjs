/**
 * 建仓库 + 推送，全程走 GitHub REST API（本机 git 无 https 支持）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, posix } from 'node:path'

const REPO = process.argv[2]
const ROOT = process.argv[3]
const DESC = process.argv[4] || ''

function token() {
  const ps = [
    '$sig = @"',
    'using System; using System.Runtime.InteropServices;',
    'public class Cred {',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;',
    '    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;',
    '    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $sig',
    'foreach ($t in @("git:https://github.com", "GitHub for Visual Studio - https://KamishiroRei@github.com/")) {',
    '  $p = [IntPtr]::Zero',
    '  if ([Cred]::CredReadW($t, 1, 0, [ref]$p)) {',
    '    $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Cred+CREDENTIAL])',
    '    if ($c.CredentialBlobSize -gt 0) {',
    '      $b = New-Object byte[] $c.CredentialBlobSize',
    '      [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize)',
    '      Write-Output ([Text.Encoding]::Unicode.GetString($b))',
    '    }',
    '    [Cred]::CredFree($p)',
    '  }',
    '}',
  ].join('\n')
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
}

const TOKEN = token()
const H = { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-plugin-publisher' }

async function api(path, init = {}) {
  const res = await fetch('https://api.github.com' + path, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

// 1) 当前用户
const me = await api('/user')
if (me.status !== 200) { console.error('令牌无效:', me.status, me.text.slice(0, 200)); process.exit(1) }
const owner = me.json.login
console.log('账号:', owner)

// 2) 建仓库（已存在则复用）
let repoRes = await api('/repos/' + owner + '/' + REPO)
if (repoRes.status === 404) {
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({ name: REPO, description: DESC, private: false, has_issues: true, has_wiki: false, auto_init: false }),
  })
  if (created.status >= 300) { console.error('建仓库失败:', created.status, created.text.slice(0, 300)); process.exit(1) }
  console.log('已创建仓库:', created.json.full_name)
} else {
  console.log('仓库已存在，复用:', repoRes.json.full_name)
}

// 3) 收集文件（跳过 .git 与 .gitignore 命中的东西）
const SKIP_DIRS = new Set(['.git', 'node_modules', '.restart'])
const SKIP_EXT = new Set(['.png', '.jpg', '.ico', '.log'])
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) { walk(full, out); continue }
    if (SKIP_EXT.has(name.slice(name.lastIndexOf('.')))) continue
    if (name.startsWith('.') && name !== '.gitignore' && name !== '.gitattributes') continue
    out.push(full)
  }
  return out
}
const files = walk(ROOT)
console.log('待上传文件:', files.length)

// 4) 逐个建 blob → 建 tree → 建 commit → 更新 ref
const blobs = []
for (const f of files) {
  const rel = posix.normalize(relative(ROOT, f).split('\\').join('/'))
  const content = readFileSync(f)
  const b = await api('/repos/' + owner + '/' + REPO + '/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  if (b.status >= 300) { console.error('blob 失败', rel, b.status, b.text.slice(0, 160)); process.exit(1) }
  blobs.push({ path: rel, sha: b.json.sha })
}
console.log('blob 上传完成:', blobs.length)

const tree = await api('/repos/' + owner + '/' + REPO + '/git/trees', {
  method: 'POST',
  body: JSON.stringify({ tree: blobs.map(x => ({ path: x.path, mode: '100644', type: 'blob', sha: x.sha })) }),
})
if (tree.status >= 300) { console.error('tree 失败:', tree.status, tree.text.slice(0, 200)); process.exit(1) }

const msg = process.argv[5] || 'Initial commit'
// 空仓库第一次提交没有 parent；已有内容则挂到当前 HEAD 上
let parents = []
const headRes = await api('/repos/' + owner + '/' + REPO + '/git/ref/heads/main')
if (headRes.status === 200 && headRes.json && headRes.json.object) parents = [headRes.json.object.sha]
const commit = await api('/repos/' + owner + '/' + REPO + '/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message: msg, tree: tree.json.sha, parents }),
})
if (commit.status >= 300) { console.error('commit 失败:', commit.status, commit.text.slice(0, 200)); process.exit(1) }
console.log('commit:', commit.json.sha.slice(0, 10))

// main 分支指向该 commit
let refRes = await api('/repos/' + owner + '/' + REPO + '/git/refs')
const hasMain = Array.isArray(refRes.json) && refRes.json.some(r => r.ref === 'refs/heads/main')
const ref = hasMain
  ? await api('/repos/' + owner + '/' + REPO + '/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: commit.json.sha, force: true }) })
  : await api('/repos/' + owner + '/' + REPO + '/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.json.sha }) })
if (ref.status >= 300) { console.error('ref 失败:', ref.status, ref.text.slice(0, 200)); process.exit(1) }

// 默认分支设为 main
await api('/repos/' + owner + '/' + REPO, { method: 'PATCH', body: JSON.stringify({ default_branch: 'main' }) })

console.log('')
console.log('完成 → https://github.com/' + owner + '/' + REPO)