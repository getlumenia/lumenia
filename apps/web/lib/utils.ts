import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Serialize an object for a `<script type="application/ld+json">` body.
 *
 * `JSON.stringify` escapes quotes but not `<`, so a string containing `</script>` closes the tag
 * early and everything after it is parsed as markup. Today every JSON-LD input here is authored in
 * the repo, but "no user input reaches this" is a property of the current code, not of the
 * function — escaping costs one replace and survives the day a title comes from somewhere else.
 */
export function jsonLdSafe(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
