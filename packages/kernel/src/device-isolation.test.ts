import { afterEach, expect, test, vi } from 'vitest';
import { AppError } from './errors.ts';
import { resolveRequestIosSimulatorDeviceSetPath } from './device-isolation.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('without AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET a request reaches the set it names, or the default set', () => {
  vi.stubEnv('AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET', '');

  expect(resolveRequestIosSimulatorDeviceSetPath(' /tmp/request-set ')).toBe('/tmp/request-set');
  expect(resolveRequestIosSimulatorDeviceSetPath(undefined)).toBeUndefined();
});

test('AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET is the set of a request that names none', () => {
  vi.stubEnv('AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET', '/tmp/operator-set');

  expect(resolveRequestIosSimulatorDeviceSetPath(undefined)).toBe('/tmp/operator-set');
  expect(resolveRequestIosSimulatorDeviceSetPath('  ')).toBe('/tmp/operator-set');
});

test('a request naming the operator set is admitted', () => {
  vi.stubEnv('AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET', '/tmp/operator-set');

  expect(resolveRequestIosSimulatorDeviceSetPath('/tmp/operator-set/')).toBe('/tmp/operator-set');
});

test('a request naming another set than the operator set is refused', () => {
  vi.stubEnv('AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET', '/tmp/operator-set');

  let refusal: unknown;
  try {
    resolveRequestIosSimulatorDeviceSetPath('/tmp/other-set');
  } catch (error) {
    refusal = error;
  }

  expect(refusal).toBeInstanceOf(AppError);
  expect(refusal).toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'ios_simulator_device_set_outside_daemon_set' },
  });
  expect((refusal as AppError).message).toContain('/tmp/operator-set');
  expect((refusal as AppError).message).toContain('/tmp/other-set');
});
