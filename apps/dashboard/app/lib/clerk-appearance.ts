/**
 * Clerk's prebuilt components (SignIn, OrganizationSwitcher, UserButton)
 * are styled through its appearance API, which takes literal values rather
 * than CSS custom properties. These mirror app/styles/tokens/colors.css and
 * typography.css — the one sanctioned place raw values appear in app code.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: "#00915a", // --accent-600
    colorText: "#0c0f0e", // --ink-900
    colorTextSecondary: "#575f5b", // --gray-600
    colorBackground: "#ffffff", // --surface-card
    colorInputBackground: "#ffffff",
    colorInputText: "#0c0f0e",
    colorNeutral: "#0c0f0e",
    colorDanger: "#c2402a", // --red-700
    borderRadius: "0px", // fully square
    fontFamily: '"Space Grotesk", "Helvetica Neue", Arial, sans-serif',
    fontFamilyButtons: '"IBM Plex Mono", "SF Mono", Menlo, monospace',
  },
  elements: {
    card: "shadow-none border border-hairline",
    cardBox: "shadow-none",
  },
} as const;
