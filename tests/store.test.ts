import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HostStore, validateAlias, validateHostPayload } from '../src/store.ts'

function pathFor(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-winrm-store-')), 'hosts.json')
}

test('host summaries never expose passwords', () => {
  const path = pathFor()
  const store = new HostStore(path)
  const entry = store.create({ alias: 'server-1', host: '127.0.0.1', user: 'Admin', auth: { kind: 'password', password: 'secret-password' }, tags: [] })
  const summary = store.summarize(entry)
  assert.equal(summary.auth, 'password')
  assert.equal('password' in summary, false)
  assert.equal(JSON.stringify(summary).includes('secret-password'), false)
  assert.equal(readFileSync(path, 'utf8').includes('secret-password'), true)
})

test('host payload and alias validation reject unsafe shapes', () => {
  assert.match(validateAlias('../bad') ?? '', /alias/)
  assert.match(validateHostPayload({ host: '', user: 'Admin' }) ?? '', /host is required/)
  assert.match(validateHostPayload({ host: 'server', user: 'Admin', port: 70000 }) ?? '', /1\.\.65535/)
  assert.match(validateHostPayload({ host: 'server', user: 'Admin', smbPort: 0 }) ?? '', /smbPort/)
  assert.match(validateHostPayload({ host: 'server', user: 'Admin', smbPort: 1.5 }) ?? '', /smbPort/)
  assert.equal(validateHostPayload({ host: 'server', user: 'Admin', smbPort: 1445 }), undefined)
})

test('the SMB port survives a round trip and can be cleared again', () => {
  const store = new HostStore(pathFor())
  const created = store.create({
    alias: 'server-2',
    host: 'server',
    user: 'Admin',
    auth: { kind: 'password', password: 'secret-password' },
    smbPort: 1445,
    tags: [],
  })
  assert.equal(created.smbPort, 1445)
  assert.equal(store.summarize(created).smbPort, 1445)
  assert.equal(new HostStore(store.path).find('server-2')?.smbPort, 1445)
  // An update that leaves smbPort alone keeps it; sending 445 overrides it.
  const kept = store.update('server-2', { description: 'note' })
  assert.equal(kept.smbPort, 1445)
  const cleared = store.update('server-2', { smbPort: 445 })
  assert.equal(cleared.smbPort, 445)
  assert.throws(() => { store.update('server-2', { smbPort: 70000 }) }, /1\.\.65535/)
})