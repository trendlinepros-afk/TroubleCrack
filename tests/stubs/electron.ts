/** Minimal Electron stub for tests. Only the surface the tested modules touch. */
export const app = {
  getPath: () => '/tmp',
  getVersion: () => '0.0.0-test'
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString()
}
export default { app, safeStorage }
