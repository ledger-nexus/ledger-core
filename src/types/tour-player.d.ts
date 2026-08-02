// JSX registration for the vendored tourkit web component
// (public/vendor/tour-player.js). Attributes are the component's public
// API — strings only, per the custom-elements contract.
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "tour-player": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src: string;
          /** "guided" (default) or "watch". */
          mode?: string;
          autoplay?: string;
        },
        HTMLElement
      >;
    }
  }
}
