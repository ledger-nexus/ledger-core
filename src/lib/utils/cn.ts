// Class-name composition helper. clsx + tailwind-merge so that conflicting
// utilities (`p-2 p-4`) collapse to the latter and conditional class strings
// work without sprinkling template literals everywhere.

import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
