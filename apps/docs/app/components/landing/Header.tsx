"use client";
import React from 'react';
import Link from 'next/link';

const links = [
  { label: 'Runtime', href: '/#runtime' },
  { label: 'Capabilities', href: '/#capabilities' },
  { label: 'Collaboration', href: '/#collaboration' },
  { label: 'Agents', href: '/#agents' },
  { label: 'Docs', href: '/docs' },
];

export const Header: React.FC = () => {
  return (
    <header className="relative z-40 w-full px-8 md:px-28 py-4 flex items-center justify-between">
      <div className="flex items-center gap-12 md:gap-20">
        <a href="#" className="flex items-center gap-2.5">
          <img src="/icon-transparent.png" alt="" className="w-7 h-7 object-contain" />
          <span className="text-xl font-bold tracking-tight text-foreground">Vitra</span>
        </a>

        <nav className="hidden md:flex items-center gap-1">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>

      <a
        href="https://github.com/ruhamabek/Vitra"
        target="_blank"
        rel="noreferrer"
        className="bg-foreground text-background rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
      >
        Star on GitHub
      </a>
    </header>
  );
};
