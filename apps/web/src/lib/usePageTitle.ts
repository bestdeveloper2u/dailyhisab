import { useEffect } from "react";

/**
 * WCAG 2.4.2 Page Titled: each routed screen describes itself in
 * document.title ("<screen> · Daily Hisab"). Runs on route mount and
 * re-runs only if the title string changes.
 */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
