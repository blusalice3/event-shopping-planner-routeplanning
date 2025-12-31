import React from 'react';

const ChainLinkIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={2}
    stroke="currentColor"
    {...props}
  >
    {/* チェーンブロックのようなデザイン */}
    <rect x="3" y="6" width="6" height="4" rx="0.5" stroke="currentColor" fill="none" />
    <rect x="15" y="6" width="6" height="4" rx="0.5" stroke="currentColor" fill="none" />
    <rect x="3" y="14" width="6" height="4" rx="0.5" stroke="currentColor" fill="none" />
    <rect x="15" y="14" width="6" height="4" rx="0.5" stroke="currentColor" fill="none" />
    {/* 連結線 */}
    <line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="2" />
    <line x1="9" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="2" />
    <line x1="12" y1="8" x2="12" y2="16" stroke="currentColor" strokeWidth="2" />
  </svg>
);

export default ChainLinkIcon;

