export const SupportTicketStatus = {
  UNREAD: 'unread',
  ACCEPTED: 'accepted',
  TRIVIAL: 'trivial',
} as const

export type SupportTicketStatus =
  (typeof SupportTicketStatus)[keyof typeof SupportTicketStatus]
