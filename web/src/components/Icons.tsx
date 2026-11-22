type P = { size?: number };
const s = (size = 20) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true });

export const Logo = () => (
  <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
    <rect width="34" height="34" rx="11" fill="#6D4AFF" />
    <path d="M10 17.5l4.5 4.5 9.5-10" stroke="#FFFFFF" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const Arrow = ({ size }: P) => <svg {...s(size)} strokeWidth={2.4}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
export const Check = ({ size }: P) => <svg {...s(size)} strokeWidth={2.8}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const Cross = ({ size }: P) => <svg {...s(size)} strokeWidth={2.8}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const Lock = ({ size }: P) => <svg {...s(size)}><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
export const Globe = ({ size }: P) => <svg {...s(size)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></svg>;
export const Chevron = ({ up, size }: P & { up?: boolean }) => <svg {...s(size ?? 16)} strokeWidth={2.4}><path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg>;
export const Upload = ({ size }: P) => <svg {...s(size)}><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>;
export const Info = ({ size }: P) => <svg {...s(size)} strokeWidth={2.2}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5h.01" /></svg>;
export const Plus = ({ size }: P) => <svg {...s(size ?? 16)} strokeWidth={2.4}><path d="M12 5v14M5 12h14" /></svg>;
export const Trash = ({ size }: P) => <svg {...s(size ?? 17)}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>;
export const Grip = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>;
export const Download = ({ size }: P) => <svg {...s(size)} strokeWidth={2.4}><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>;
export const Bell = ({ size }: P) => <svg {...s(size ?? 18)}><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;
export const Play = ({ size }: P) => <svg width={size ?? 14} height={size ?? 14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;
export const ListIcon = ({ size }: P) => <svg {...s(size)} strokeWidth={2.2}><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>;
export const Video = ({ size }: P) => <svg {...s(size)} strokeWidth={2.2}><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="M16 10.5l5-3v9l-5-3" /></svg>;
export const FileIcon = ({ size }: P) => <svg {...s(size)} strokeWidth={2.2}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></svg>;
