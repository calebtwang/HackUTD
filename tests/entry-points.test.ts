import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntryPoints } from '../server/entry-points';
const base='http://127.0.0.1:3210';
const ids=['scout','finch'];
test('local shorthand and relative paths resolve to the actual demo origin',()=>{
  for(const raw of ['localhost/forum','http://localhost/forum','http://localhost:3210/forum','127.0.0.1:3210/forum','/forum']) {
    assert.deepEqual(normalizeEntryPoints({scout:raw,finch:''},ids,base),{scout:`${base}/forum`,finch:''});
  }
});
test('either or both agents may receive entry points',()=>{
  assert.deepEqual(normalizeEntryPoints({scout:'',finch:'/forum'},ids,base),{scout:'',finch:`${base}/forum`});
  assert.deepEqual(normalizeEntryPoints({scout:'/forum',finch:'/phishing'},ids,base),{scout:`${base}/forum`,finch:`${base}/phishing`});
});
test('public entry points remain external for read-only discovery',()=>{
  assert.deepEqual(normalizeEntryPoints({scout:'https://example.com/forum',finch:'example.org'},ids,base),{scout:'https://example.com/forum',finch:'http://example.org/'});
});
test('credential-bearing, private and other-port entries are rejected',()=>{
  for(const raw of ['http://user:pass@localhost/forum','http://127.0.0.1:9999/forum','https://localhost/forum','file:///etc/passwd','http://10.0.0.1/forum','http://169.254.169.254/']) {
    assert.throws(()=>normalizeEntryPoints({scout:raw},ids,base));
  }
  assert.throws(()=>normalizeEntryPoints({scout:' ',finch:''},ids,base),/at least one/);
  assert.throws(()=>normalizeEntryPoints({wren:'/forum'},ids,base),/Unknown agent/);
});
