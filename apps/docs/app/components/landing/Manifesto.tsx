"use client";
import React, { useRef } from 'react';
import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion';

const statement =
  'Most AI tools write UI by looking at screenshots and guessing pixel values. Vitra gives agents and teams a real runtime to inspect, construct, and audit interfaces with guaranteed precision.';

const Word: React.FC<{ word: string; index: number; total: number; progress: MotionValue<number> }> = ({
  word,
  index,
  total,
  progress,
}) => {
  const range = [index / total, (index + 1) / total];
  const opacity = useTransform(progress, range, [0.2, 1]);
  const color = useTransform(progress, range, ['hsl(0 0% 35%)', 'hsl(0 0% 100%)']);

  return (
    <motion.span style={{ opacity, color }} className="mr-[0.3em]">
      {word}
    </motion.span>
  );
};

export const Manifesto: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start end', 'end center'] });
  const words = statement.split(' ');

  return (
    <section className="min-h-screen flex items-center justify-center py-24 md:py-32 px-8 md:px-28">
      <div ref={containerRef} className="max-w-3xl mx-auto flex flex-col items-start gap-10">
        <span aria-hidden className="font-serif text-8xl leading-none h-10 text-foreground">
          &ldquo;
        </span>

        <p className="flex flex-wrap text-4xl md:text-5xl font-medium leading-[1.2]">
          {words.map((word, i) => (
            <Word key={i} word={word} index={i} total={words.length} progress={scrollYProgress} />
          ))}
          <span className="text-muted-foreground ml-2">&rdquo;</span>
        </p>

        <div className="flex items-center gap-4">
          <img
            src="/icon.png"
            alt=""
            className="w-14 h-14 rounded-full border-[3px] border-foreground object-cover"
          />
          <div>
            <div className="text-base font-semibold leading-7 text-foreground">Vitra Protocol</div>
            <div className="text-sm font-normal leading-5 text-muted-foreground">Open source under AGPL-3.0</div>
          </div>
        </div>
      </div>
    </section>
  );
};
