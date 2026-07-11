/// <reference types="vite/client" />

declare namespace React.JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      src?: string
      partition?: string
      webpreferences?: string
    }
  }
}

interface Window {
  ranparty: {
    isElectron: boolean
    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
    chooseDirectory(): Promise<string | null>
    chooseImages(): Promise<Array<{ name: string; dataUrl: string; size: number }>>
    chooseFile(): Promise<string | null>
    clipboardWrite(text: string): Promise<{ ok: boolean }>
    pathAction(action: 'open', path: string): Promise<{ ok: boolean }>
    onEvent(listener: (event: string, data: unknown) => void): () => void
  }
}
