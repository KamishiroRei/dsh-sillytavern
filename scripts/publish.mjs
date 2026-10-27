import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, posix } from 'node:path'

const REPO = process.argv[2]
const ROOT = process.argv[3]
const MSG = process.argv[4] || 'update'

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
  '"@','Add-Type -TypeDefinition $sig',
  'foreach ($t in @("git:https://github.com", "GitHub for Visual Studio - https://KamishiroRei@github.com/")) {',
  '  $p = [IntPtr]::Zero',
  '  if ([Cred]::CredReadW($t, 1, 0, [ref]$p)) {',
  '    $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Cred+CREDENTIAL])',
  '    if ($c.CredentialBlobSize -gt 0) { $b = New-Object byte[] $c.CredentialBlobSize; [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize); Write-Output ([Text.Encoding]::Unicode.GetString($b)) }',
  '    [Cred]::CredFree($p) } }',
].join('\n')
const TOKEN = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
const H = { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'x' }
const B = 'https://api.github.com/repos/KamishiroRei/' + REPO

async function api(path, init = {}) {
  const res = await fetch(B + path, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

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
console.log('files:', files.length)
const blobs = []
for (const f of files) {
  const rel = posix.normalize(relative(ROOT, f).split('\\').join('/'))
  const b = await api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: readFileSync(f).toString('base64'), encoding: 'base64' }) })
  if (b.status >= 300) { console.error('blob fail', rel, b.status, b.text.slice(0, 120)); process.exit(1) }
  blobs.push({ path: rel, sha: b.json.sha })
}
const tree = await api('/git/trees', { method: 'POST', body: JSON.stringify({ tree: blobs.map(x => ({ path: x.path, mode: '100644', type: 'blob', sha: x.sha })) }) })
if (tree.status >= 300) { console.error('tree fail', tree.status, tree.text.slice(0, 200)); process.exit(1) }

let parents = []
const head = await api('/git/ref/heads/main')
if (head.status === 200 && head.json && head.json.object) parents = [head.json.object.sha]
const commit = await api('/git/commits', { method: 'POST', body: JSON.stringify({ message: MSG, tree: tree.json.sha, parents }) })
if (commit.status >= 300) { console.error('commit fail', commit.status, commit.text.slice(0, 200)); process.exit(1) }

const ref = parents.length
  ? await api('/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: commit.json.sha, force: true }) })
  : await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.json.sha }) })
if (ref.status >= 300) { console.error('ref fail', ref.status, ref.text.slice(0, 200)); process.exit(1) }

console.log('pushed:', commit.json.sha.slice(0, 10))
console.log('https://github.com/KamishiroRei/' + REPO)
