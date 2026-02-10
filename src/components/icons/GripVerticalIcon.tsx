import React from 'react';

const GripVerticalIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg 
        viewBox="0 0 24 24" 
        fill="currentColor" 
        xmlns="http://www.w3.org/2000/svg"
        {...props}
    >
        <circle cx="10" cy="5" r="1.5" />
        <circle cx="14" cy="5" r="1.5" />
        <circle cx="10" cy="12" r="1.5" />
        <circle cx="14" cy="12" r="1.5" />
        <circle cx="10" cy="19" r="1.5" />
        <circle cx="14" cy="19" r="1.5" />
    </svg>
);

export default GripVerticalIcon;
