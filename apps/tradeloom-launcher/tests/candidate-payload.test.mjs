import test from 'node:test'
import assert from 'node:assert/strict'
import { choosePayloadAddress, DEFAULT_RUNTIME_CANDIDATE } from '../candidate-payload.mjs'

const ethernet = { name: '以太网', interfaceDescription: 'Realtek PCIe GbE Family Controller', kind: 'ethernet',
  status: 'Up', hardwareInterface: true, addresses: [{ addressFamily: 'IPv4', address: '192.168.20.7' }] }

test('PowerShell singleton/object and multi-adapter JSON payloads resolve through physical adapter metadata', () => {
  assert.equal(DEFAULT_RUNTIME_CANDIDATE, '0.2.1-rc.2-tradeloom-desktop-2')
  const singletonJson = JSON.stringify(ethernet)
  assert.equal(choosePayloadAddress(JSON.parse(singletonJson), '192.168.20.7'), '192.168.20.7')
  const two = [ethernet, { ...ethernet, name: 'Wi-Fi', kind: 'wifi', addresses: [{ addressFamily: 'IPv4', address: '10.1.2.3' }] }]
  assert.equal(choosePayloadAddress(JSON.parse(JSON.stringify(two)), '10.1.2.3'), '10.1.2.3')
  assert.throws(() => choosePayloadAddress(JSON.parse(singletonJson), '8.8.8.8'), /当前活动物理网卡/)
})
