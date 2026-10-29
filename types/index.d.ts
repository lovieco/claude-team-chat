export type ChatMessage = {
  id: number
  from: string
  text: string
  at: number
  via?: 'claude'
}

declare module 'claude-code' {
  interface PluginState {
    'claude-team-chat': {
      room: string
      epoch: string
      messages: ChatMessage[]
      online: string[]
      unread: number
      isOpen: boolean
      problem: string
      sent: number
      me: string
      menuOpen: boolean
      minimized: boolean
      notice: string
    }
  }
}
