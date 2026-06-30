// Curated catalog of open-source fonts that actually appear in short-form
// (TikTok/Reels) burned-in captions. We match a detected caption against
// THIS closed set instead of asking the vision model to free-name a font
// (which it does unreliably — it guesses "bold sans-serif" or hallucinates
// "Montserrat"). All fonts are OFL/Apache licensed and downloaded from the
// Google Fonts repo by scripts/download-fonts.ts into resources/fonts/.
//
// `github` is the path under github.com/google/fonts/raw/main/. Variable
// fonts use the [wght] axis filename; the browser still renders them at any
// weight via @font-face, so they work as references. `look` is a short
// human descriptor used only in UI / prompts, never for matching.

export interface CatalogFont {
  /** Stable id (kebab-case). Stored as caption_style.font_family. */
  id: string;
  /** Display + CSS family name. */
  family: string;
  /** Path under github.com/google/fonts/raw/main/ to the .ttf. */
  github: string;
  /** Coarse visual family, for grouping + the picker. */
  group: 'impact' | 'bold_sans' | 'rounded' | 'condensed' | 'clean_sans' | 'display';
  /** One-line look descriptor (UI/prompt only). */
  look: string;
}

export const FONT_CATALOG: CatalogFont[] = [
  // --- Impact / heavy display (the "Hormozi / Beast" big bold look) ---
  { id: 'anton', family: 'Anton', github: 'ofl/anton/Anton-Regular.ttf', group: 'impact', look: 'ultra-bold condensed grotesque, the classic loud caption look' },
  { id: 'alfa-slab-one', family: 'Alfa Slab One', github: 'ofl/alfaslabone/AlfaSlabOne-Regular.ttf', group: 'impact', look: 'heavy slab serif, thick and blocky' },
  { id: 'passion-one', family: 'Passion One', github: 'ofl/passionone/PassionOne-Bold.ttf', group: 'impact', look: 'fat rounded-bold display' },
  { id: 'teko', family: 'Teko', github: 'ofl/teko/Teko%5Bwght%5D.ttf', group: 'condensed', look: 'tall narrow condensed, sporty' },

  // --- Bold geometric / grotesque sans (most common modern caption) ---
  { id: 'montserrat', family: 'Montserrat', github: 'ofl/montserrat/Montserrat%5Bwght%5D.ttf', group: 'bold_sans', look: 'geometric sans, even and clean, very common' },
  { id: 'poppins', family: 'Poppins', github: 'ofl/poppins/Poppins-Bold.ttf', group: 'rounded', look: 'geometric with circular bowls, friendly' },
  { id: 'league-spartan', family: 'League Spartan', github: 'ofl/leaguespartan/LeagueSpartan%5Bwght%5D.ttf', group: 'bold_sans', look: 'tight geometric, strong verticals' },
  { id: 'archivo', family: 'Archivo', github: 'ofl/archivo/Archivo%5Bwdth,wght%5D.ttf', group: 'bold_sans', look: 'grotesque, slightly condensed, editorial' },
  { id: 'kanit', family: 'Kanit', github: 'ofl/kanit/Kanit-Bold.ttf', group: 'bold_sans', look: 'loopless geometric, a bit narrow' },
  { id: 'barlow', family: 'Barlow', github: 'ofl/barlow/Barlow-Bold.ttf', group: 'bold_sans', look: 'low-contrast grotesque, slightly rounded' },

  // --- Condensed ---
  { id: 'oswald', family: 'Oswald', github: 'ofl/oswald/Oswald%5Bwght%5D.ttf', group: 'condensed', look: 'condensed gothic, tall and narrow' },
  { id: 'bebas-neue', family: 'Bebas Neue', github: 'ofl/bebasneue/BebasNeue-Regular.ttf', group: 'condensed', look: 'all-caps tall condensed, very common in titles' },

  // --- Rounded / playful ---
  { id: 'fredoka', family: 'Fredoka', github: 'ofl/fredoka/Fredoka%5Bwdth,wght%5D.ttf', group: 'rounded', look: 'soft rounded, chunky and friendly' },
  { id: 'baloo-2', family: 'Baloo 2', github: 'ofl/baloo2/Baloo2%5Bwght%5D.ttf', group: 'rounded', look: 'heavy rounded display, bubbly' },
  { id: 'nunito', family: 'Nunito', github: 'ofl/nunito/Nunito%5Bwght%5D.ttf', group: 'rounded', look: 'rounded terminals, soft sans' },

  // --- Display / hand / comic (Komika-style) ---
  { id: 'luckiest-guy', family: 'Luckiest Guy', github: 'apache/luckiestguy/LuckiestGuy-Regular.ttf', group: 'display', look: 'comic all-caps brush, bouncy' },
  { id: 'bangers', family: 'Bangers', github: 'ofl/bangers/Bangers-Regular.ttf', group: 'display', look: 'comic-book caps, energetic' },

  // --- Clean neutral sans (minimal / lower-third captions) ---
  { id: 'inter', family: 'Inter', github: 'ofl/inter/Inter%5Bopsz,wght%5D.ttf', group: 'clean_sans', look: 'neutral UI sans, highly legible' },
  { id: 'work-sans', family: 'Work Sans', github: 'ofl/worksans/WorkSans%5Bwght%5D.ttf', group: 'clean_sans', look: 'neutral grotesque, plain' },
  { id: 'rubik', family: 'Rubik', github: 'ofl/rubik/Rubik%5Bwght%5D.ttf', group: 'clean_sans', look: 'slightly rounded corners, neutral' },
];

/** Filename a font is saved under in resources/fonts/. */
export function fontFile(f: CatalogFont): string {
  return `${f.id}.ttf`;
}
