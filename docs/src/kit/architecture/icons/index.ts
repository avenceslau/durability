import { cloudflareIcons } from "./cloudflare"
import { genericIcons } from "./generic"
import type { IconName } from "./names"

/** Every built-in icon by name: square SVGs drawn in currentColor. */
export const architectureIcons: Readonly<Record<IconName, React.JSX.Element>> = {
  ...cloudflareIcons,
  ...genericIcons,
}
