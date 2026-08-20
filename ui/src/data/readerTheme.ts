// The reader's fixed visual defaults: Literata (self-hosted via
// @fontsource, not a Google Fonts CDN link) for body text. The outer reader frame
// stays sized for 24px text while the renderer keeps a smaller pagination
// gutter on mobile and its full inter-column gutter on desktop.
// epub.js renders each section in its own iframe document, so this can't
// just be a normal CSS import in main.tsx -- @font-face declarations
// don't cross from the outer page into a child iframe's own document.
// Injected instead as raw CSS via Rendition.themes.registerCss().
//
// The private family name prevents an EPUB's embedded @font-face from being
// merged with the reader face. EpubRenderer also uses Rendition.themes.font()
// for the body override; the descendant rule is needed because a font declared
// directly on a paragraph/span wins over an inherited body value. Root inline
// spacing is reset so publisher CSS cannot offset the paginated body inside its
// already-balanced reader gutter.
//
// Each style/weight is split by unicode range, so the browser fetches only the
// faces used by the rendered text. Real regular, italic, bold, and bold-italic
// faces avoid synthetic glyphs and preserve the EPUB's semantic emphasis.
import literataCyrillicExt from "@fontsource/literata/files/literata-cyrillic-ext-400-normal.woff2";
import literataCyrillicExtItalic from "@fontsource/literata/files/literata-cyrillic-ext-400-italic.woff2";
import literataCyrillicExtBold from "@fontsource/literata/files/literata-cyrillic-ext-700-normal.woff2";
import literataCyrillicExtBoldItalic from "@fontsource/literata/files/literata-cyrillic-ext-700-italic.woff2";
import literataCyrillic from "@fontsource/literata/files/literata-cyrillic-400-normal.woff2";
import literataCyrillicItalic from "@fontsource/literata/files/literata-cyrillic-400-italic.woff2";
import literataCyrillicBold from "@fontsource/literata/files/literata-cyrillic-700-normal.woff2";
import literataCyrillicBoldItalic from "@fontsource/literata/files/literata-cyrillic-700-italic.woff2";
import literataGreekExt from "@fontsource/literata/files/literata-greek-ext-400-normal.woff2";
import literataGreekExtItalic from "@fontsource/literata/files/literata-greek-ext-400-italic.woff2";
import literataGreekExtBold from "@fontsource/literata/files/literata-greek-ext-700-normal.woff2";
import literataGreekExtBoldItalic from "@fontsource/literata/files/literata-greek-ext-700-italic.woff2";
import literataGreek from "@fontsource/literata/files/literata-greek-400-normal.woff2";
import literataGreekItalic from "@fontsource/literata/files/literata-greek-400-italic.woff2";
import literataGreekBold from "@fontsource/literata/files/literata-greek-700-normal.woff2";
import literataGreekBoldItalic from "@fontsource/literata/files/literata-greek-700-italic.woff2";
import literataVietnamese from "@fontsource/literata/files/literata-vietnamese-400-normal.woff2";
import literataVietnameseItalic from "@fontsource/literata/files/literata-vietnamese-400-italic.woff2";
import literataVietnameseBold from "@fontsource/literata/files/literata-vietnamese-700-normal.woff2";
import literataVietnameseBoldItalic from "@fontsource/literata/files/literata-vietnamese-700-italic.woff2";
import literataLatinExt from "@fontsource/literata/files/literata-latin-ext-400-normal.woff2";
import literataLatinExtItalic from "@fontsource/literata/files/literata-latin-ext-400-italic.woff2";
import literataLatinExtBold from "@fontsource/literata/files/literata-latin-ext-700-normal.woff2";
import literataLatinExtBoldItalic from "@fontsource/literata/files/literata-latin-ext-700-italic.woff2";
import literataLatin from "@fontsource/literata/files/literata-latin-400-normal.woff2";
import literataLatinItalic from "@fontsource/literata/files/literata-latin-400-italic.woff2";
import literataLatinBold from "@fontsource/literata/files/literata-latin-700-normal.woff2";
import literataLatinBoldItalic from "@fontsource/literata/files/literata-latin-700-italic.woff2";

interface Subset {
  regular: string;
  italic: string;
  bold: string;
  boldItalic: string;
  unicodeRange: string;
}

const SUBSETS: Subset[] = [
  {
    regular: literataCyrillicExt,
    italic: literataCyrillicExtItalic,
    bold: literataCyrillicExtBold,
    boldItalic: literataCyrillicExtBoldItalic,
    unicodeRange: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F",
  },
  {
    regular: literataCyrillic,
    italic: literataCyrillicItalic,
    bold: literataCyrillicBold,
    boldItalic: literataCyrillicBoldItalic,
    unicodeRange: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116",
  },
  {
    regular: literataGreekExt,
    italic: literataGreekExtItalic,
    bold: literataGreekExtBold,
    boldItalic: literataGreekExtBoldItalic,
    unicodeRange: "U+1F00-1FFF",
  },
  {
    regular: literataGreek,
    italic: literataGreekItalic,
    bold: literataGreekBold,
    boldItalic: literataGreekBoldItalic,
    unicodeRange: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF",
  },
  {
    regular: literataVietnamese,
    italic: literataVietnameseItalic,
    bold: literataVietnameseBold,
    boldItalic: literataVietnameseBoldItalic,
    unicodeRange:
      "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301," +
      "U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
  },
  {
    regular: literataLatinExt,
    italic: literataLatinExtItalic,
    bold: literataLatinExtBold,
    boldItalic: literataLatinExtBoldItalic,
    unicodeRange:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329," +
      "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
  {
    regular: literataLatin,
    italic: literataLatinItalic,
    bold: literataLatinBold,
    boldItalic: literataLatinBoldItalic,
    unicodeRange:
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329," +
      "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
];

const FACES = [
  { key: "regular", style: "normal", weight: 400 },
  { key: "italic", style: "italic", weight: 400 },
  { key: "bold", style: "normal", weight: 700 },
  { key: "boldItalic", style: "italic", weight: 700 },
] as const;

const fontFaceRules = SUBSETS.flatMap((subset) =>
  FACES.map(
    (face) => `
@font-face {
  font-family: 'Txt Literata';
  font-style: ${face.style};
  font-weight: ${face.weight};
  font-display: swap;
  src: url(${subset[face.key]}) format('woff2');
  unicode-range: ${subset.unicodeRange};
}`,
  ),
).join("\n");

export const READER_FONT_FAMILY = "'Txt Literata', serif";

// Mirrors theme.scss's cream/ink/terracotta palette. Can't share those Sass
// variables directly -- this string is injected into each section's own
// iframe document via Rendition.themes.registerCss(), a separate build/style
// pipeline from the outer app shell -- so the literal hex values are
// duplicated here instead.
// ":not(#txt-reader-theme-shield)" matches every element (no real element
// carries that id) but adds ID-level selector specificity, which beats any
// number of a publisher's own class/attribute selectors -- even
// !important ones -- without a stylesheet-stripping approach that would
// also discard the font-size/font-style/text-align declarations a book
// legitimately needs (a smaller image caption, an italic class instead of
// <em>, a right-aligned byline). Only color/background is boosted this
// way; every other property is left for the book's own CSS to set.
const SHIELD = ":not(#txt-reader-theme-shield)";

export const READER_THEME_CSS = `
${fontFaceRules}
html, body {
  margin-inline: 0 !important;
}
html {
  padding-inline: 0 !important;
}
html${SHIELD}, body${SHIELD} {
  background-color: #faf9f5 !important;
  color: #3d3929 !important;
}
body, body * {
  font-family: 'Txt Literata', serif !important;
}
body ${SHIELD} {
  background-color: transparent !important;
  color: inherit !important;
}
a${SHIELD}, a${SHIELD}:link, a${SHIELD}:visited {
  color: #d97757 !important;
}
body {
  font-kerning: normal !important;
  font-synthesis: none !important;
  font-variant-ligatures: common-ligatures contextual !important;
  line-height: 1.5 !important;
  text-rendering: optimizeLegibility;
}
p {
  hyphens: auto !important;
  line-height: 1.5 !important;
  orphans: 2;
  text-justify: inter-word;
  text-wrap: pretty;
  widows: 2;
}
p:not(:has(img, svg, object, picture, video)) {
  text-align: justify;
}
figcaption,
figcaption p,
[class*="caption" i],
p:has(img, svg, object, picture, video) + p {
  text-align: center !important;
}
h1, h2, h3, h4, h5, h6 {
  break-after: avoid;
  text-wrap: balance;
}
/* Some EPUB generators use preformatted blocks for ordinary prose. Keep
   those blocks in the reading face; only elements that semantically mark
   code or keyboard/sample output should opt into monospace. */
pre {
  font-family: 'Txt Literata', serif !important;
}
code, kbd, samp {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace !important;
  font-variant-ligatures: none !important;
  hyphens: none !important;
  text-align: start !important;
}
img, svg, table {
  max-width: 100%;
  height: auto;
}
`;
