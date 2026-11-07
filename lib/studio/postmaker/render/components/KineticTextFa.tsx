// Persian kinetic text (quality "Kinetic typography: Persian"): the container is always lang="fa" dir="rtl";
// animate by word, never by character (a ZWNJ stays inside its token); Latin runs are one <bdi> token.
import React from 'react';
import { KineticText, type KineticProps } from './KineticText';

export const KineticTextFa: React.FC<Omit<KineticProps, 'lang'>> = (p) => <KineticText {...p} lang="fa" rtl />;
