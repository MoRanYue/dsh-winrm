/**
 * Sidebar `panellist` icon for the WinRM panel. The shell owns the row
 * button and its label; this component only renders the glyph at the size
 * and active state the row requests.
 */
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** One glyph contribution for the `sidebar.panellist` list slot. */
export function WinrmPanelIcon({ size }: SidebarPanelIconOwnerProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2.5 6.5h11" />
      <path d="M6 6.5v7" />
    </svg>
  )
}
