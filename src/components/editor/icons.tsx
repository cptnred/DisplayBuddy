import type { ReactNode } from "react";

/** 16 px stroke icons drawn on a 24-unit grid (no icon library). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const BoldIcon = () => (
  <Icon>
    <path d="M7 4.5h6a3.75 3.75 0 0 1 0 7.5H7z" strokeWidth="2.6" />
    <path d="M7 12h7a3.75 3.75 0 0 1 0 7.5H7z" strokeWidth="2.6" />
  </Icon>
);

export const ItalicIcon = () => (
  <Icon>
    <path d="M10 4.5h8M6 19.5h8M14.5 4.5l-5 15" />
  </Icon>
);

export const UnderlineIcon = () => (
  <Icon>
    <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20.5h14" />
  </Icon>
);

export const StrikeIcon = () => (
  <Icon>
    <path d="M4.5 12h15" />
    <path d="M16.5 7.5C16 5.9 14.3 4.8 12 4.8c-2.6 0-4.3 1.3-4.3 3.1 0 1.2.7 2 1.9 2.6" />
    <path d="M7.5 16.3c.5 1.7 2.2 2.9 4.6 2.9 2.7 0 4.4-1.3 4.4-3.2 0-.6-.2-1.2-.5-1.6" />
  </Icon>
);

export const TextColorIcon = ({ color }: { color?: string }) => (
  <Icon>
    <path d="M6.5 16 12 3.5 17.5 16M8.6 11.5h6.8" />
    <rect
      x="3.5"
      y="19"
      width="17"
      height="3.2"
      rx="1"
      fill={color ?? "currentColor"}
      stroke="none"
    />
  </Icon>
);

export const BulletListIcon = () => (
  <Icon>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <circle cx="5" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="5" cy="18" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);

export const OrderedListIcon = () => (
  <Icon>
    <path d="M11 6h9M11 12h9M11 18h9" />
    <path d="M4.5 4.5 6 3.8V9" strokeWidth="1.7" />
    <path d="M4 14.5c.3-.9 2.8-1.2 2.8.4 0 1.1-2.8 2.1-2.8 3.6h3" strokeWidth="1.7" />
  </Icon>
);

export const TaskListIcon = () => (
  <Icon>
    <rect x="3" y="3.5" width="6.5" height="6.5" rx="1.3" strokeWidth="1.8" />
    <path d="m4.6 6.8 1.3 1.3L8 5.6" strokeWidth="1.7" />
    <rect x="3" y="14" width="6.5" height="6.5" rx="1.3" strokeWidth="1.8" />
    <path d="M13 6.8h8M13 17.2h8" />
  </Icon>
);

export const UndoIcon = () => (
  <Icon>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);

export const RedoIcon = () => (
  <Icon>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Icon>
);
