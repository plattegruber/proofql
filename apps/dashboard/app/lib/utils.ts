import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge must be taught the design system's custom font-size tokens
// (defined in app.css @theme); otherwise it would classify `text-label` etc.
// as text colors and wrongly drop them when merged with `text-gray-500`.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "2xs",
            "label",
            "data",
            "quote",
            "small",
            "body",
            "title",
            "h1",
            "display-sm",
            "display-md",
            "display-lg",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
