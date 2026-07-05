/// <reference types="vite/client" />

interface Window {
  ranparty: {
    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
    chooseDirectory(): Promise<string | null>
    chooseImages(): Promise<Array<{ name: string; dataUrl: string; size: number }>>
    chooseFile(): Promise<string | null>
    pathAction(action: 'open' | 'open-with' | 'copy-path' | 'copy-file' | 'open-browser', path: string): Promise<{ ok: boolean; cancelled?: boolean }>
    onEvent(listener: (event: string, data: unknown) => void): void
  }
}
