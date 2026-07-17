// Shared site identity used by metadata, robots, sitemap, and the OG image.
export const SITE_URL = (process.env.APP_BASE_URL ?? 'https://www.latchwork.io').replace(/\/+$/, '');

export const SITE_NAME = 'Latchwork';

export const SITE_TITLE = 'Latchwork — Online Digital Logic Simulator';

export const SITE_TAGLINE = 'Design and simulate digital logic circuits in your browser';

export const SITE_DESCRIPTION =
  'Free online digital logic simulator: build circuits with logic gates, flip-flops, buses and 7-segment displays, write VHDL modules, explore truth tables, state machines and timing diagrams, and package your designs into reusable chips.';
