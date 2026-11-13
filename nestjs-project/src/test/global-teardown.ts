// Releases the test-run advisory lock taken in global-setup.ts.
export default async function globalTeardown(): Promise<void> {
  await globalThis.__STREAMTUBE_TEST_RUN_LOCK__?.release();
  globalThis.__STREAMTUBE_TEST_RUN_LOCK__ = undefined;
}
