/**
 * Post-build step: wrap the rolldown CJS client bundle in the GUI module
 * loader handoff (window.__ModuleLoader__.load({id, factory})) and restore
 * the CJS preamble (var module/exports) that this rolldown generation omits,
 * exactly matching the official dsh-web-ui artifact shape. Emits
 * lib/client.js that the loader serves at /plugins/winrm/client.js.
 *
 * The source map stays a local debugging aid and is not part of the published
 * payload (`files` omits `*.map`), so the wrapper does not reference it — a
 * published bundle must not point at a file that is not shipped.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const lib = fileURLToPath(new URL('../lib/', import.meta.url))
const id = 'dsh-winrm'

const cjs = readFileSync(join(lib, 'client.cjs'), 'utf8')
const map = join(lib, 'client.cjs.map')
const mapJs = join(lib, 'client.js.map')
try { renameSync(map, mapJs) } catch { /* optional */ }

const body = cjs.replace(/\/\/# sourceMappingURL=client\.cjs\.map\s*$/, '')
const wrapped = [
  'window.__ModuleLoader__.load({',
  '\tid: ' + JSON.stringify(id) + ',',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

writeFileSync(join(lib, 'client.js'), wrapped)
try { renameSync(join(lib, 'client.cjs'), join(lib, 'client.cjs.bak')) } catch { /* keep both is fine */ }
console.log('postbuild: wrapped lib/client.js (' + wrapped.length + 'B)')
