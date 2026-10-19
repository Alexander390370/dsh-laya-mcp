// 验证修复后的 Config 是 schemastery 形态（用 mock 替代真实包）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, 'index.js'), 'utf8')

const mockZ = `const mk = (dv) => {
  const s = { meta: { default: dv } }
  s.default = (v) => { s.meta.default = v; return s }
  s.description = () => s
  s.required = () => s
  return s
}
const z = {
  string: () => mk(''),
  boolean: () => mk(false),
  number: () => mk(0),
  array: (i) => { const s = mk([]); s._inner = i; return s },
  object: (shape) => {
    const s = mk(undefined)
    s._shape = shape
    s['~standard'] = { vendor: 'schemastery' }
    s.simplify = (v) => v
    return s
  },
}
export default z
`

fs.writeFileSync(path.join(here, '__vz.mjs'), mockZ)
const patched = src.replace(/import z from '@deepseek-ai\/schemastery'/, "import z from './__vz.mjs'")
if (patched === src) { console.error('FATAL: import 未替换'); process.exit(1) }
fs.writeFileSync(path.join(here, '__vp.mjs'), patched)

const m = await import('file:///' + path.join(here, '__vp.mjs').replace(/\\/g, '/'))

console.log('=== Config 形态检查（关键：必须是 schemastery 对象）===')
const C = m.Config
console.log('  typeof Config      :', typeof C)
console.log('  ~standard 存在     :', C['~standard'] !== undefined)
console.log('  ~standard.vendor   :', C['~standard'] && C['~standard'].vendor)
console.log('  simplify 存在      :', typeof C.simplify === 'function')
console.log('  isSchemastery 判定 :', C?.['~standard']?.vendor === 'schemastery')

console.log('\n=== 导出清单 ===')
console.log('  exports:', Object.keys(m).sort().join(', '))
console.log('  name   :', m.name)
console.log('  inject :', JSON.stringify(m.inject))

console.log('\n=== Config 字段默认值 ===')
const shape = C._shape || {}
for (const [k, v] of Object.entries(shape)) {
  console.log(`  ${k}: default =`, JSON.stringify(v.meta && v.meta.default))
}

let ok = true
if (typeof C !== 'object') { console.log('\nFAIL: Config 不是对象'); ok = false }
if (C['~standard']?.vendor !== 'schemastery') { console.log('\nFAIL: 不是 schemastery'); ok = false }
if (typeof C.simplify !== 'function') { console.log('\nFAIL: 缺 simplify'); ok = false }
if (typeof m.apply !== 'function') { console.log('\nFAIL: 缺 apply'); ok = false }
if (!Array.isArray(m.inject)) { console.log('\nFAIL: inject 不是数组'); ok = false }

console.log(ok ? '\n全部检查通过' : '\n存在失败项')

try { fs.unlinkSync(path.join(here, '__vz.mjs')) } catch {}
try { fs.unlinkSync(path.join(here, '__vp.mjs')) } catch {}
if (!ok) process.exit(1)
