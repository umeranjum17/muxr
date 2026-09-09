/**
 * Typography system for muxr
 *
 * Default typography: IBM Plex Sans
 * Monospace typography: IBM Plex Mono
 * Logo typography: Bricolage Grotesque (specific use only)
 */

export const FontFamilies = {
  default: {
    regular: 'IBMPlexSans-Regular',
    italic: 'IBMPlexSans-Italic',
    semiBold: 'IBMPlexSans-SemiBold',
  },
  mono: {
    regular: 'IBMPlexMono-Regular',
    italic: 'IBMPlexMono-Italic',
    semiBold: 'IBMPlexMono-SemiBold',
  },
  logo: {
    bold: 'BricolageGrotesque-Bold',
  },
};

export const getDefaultFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return FontFamilies.default[weight];
};

export const getMonoFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return FontFamilies.mono[weight];
};

export const getLogoFont = () => {
  return FontFamilies.logo.bold;
};

export const FontWeights = {
  regular: '400',
  semiBold: '600',
  bold: '700',
} as const;

export const Typography = {
  default: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getDefaultFont(weight),
  }),
  mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getMonoFont(weight),
  }),
  logo: () => ({
    fontFamily: getLogoFont(),
  }),
  header: () => ({
    fontFamily: getDefaultFont('semiBold'),
  }),
  body: () => ({
    fontFamily: getDefaultFont('regular'),
  }),
};
