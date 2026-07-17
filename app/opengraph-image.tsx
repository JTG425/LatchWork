import { ImageResponse } from 'next/og';
import { SITE_TAGLINE } from '@/lib/site';

export const alt = 'Latchwork — online digital logic simulator';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#131316',
          color: '#ececf1',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 48 }}>
          <svg width="200" height="200" viewBox="0 0 64 64">
            <path
              d="M2 20 H6 M2 32 H6 M2 44 H6 M58 20 H62 M58 32 H62 M58 44 H62"
              stroke="#5a5a66"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <rect x="6" y="6" width="52" height="52" rx="14" fill="#1f1f24" stroke="#45454f" strokeWidth="2.5" />
            <path
              d="M25 17 V45 H46"
              fill="none"
              stroke="#0a84ff"
              strokeWidth="6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="25" cy="17" r="5" fill="#0a84ff" />
            <circle cx="46" cy="45" r="5" fill="#30d158" />
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 96, fontWeight: 700, letterSpacing: -2 }}>Latchwork</div>
            <div style={{ fontSize: 34, color: '#8e8e99', marginTop: 12, maxWidth: 700 }}>
              {SITE_TAGLINE}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, marginTop: 72 }}>
          {['Logic gates', 'Flip-flops', 'Buses', 'VHDL', 'Timing diagrams', 'Custom chips'].map((label) => (
            <div
              key={label}
              style={{
                display: 'flex',
                padding: '10px 24px',
                borderRadius: 999,
                border: '1.5px solid #34343c',
                background: 'rgba(30,30,35,.88)',
                color: '#b9b9c4',
                fontSize: 24,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
