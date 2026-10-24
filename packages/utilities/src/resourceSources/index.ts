export interface IResourceSource {
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
}
