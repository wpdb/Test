# Astro Component Patterns

## Basic Component
```astro
---
// src/components/Card.astro
interface Props {
    title: string;
    description?: string;
}
const { title, description = '' } = Astro.props;
---

<div class="bg-surface-alt rounded-lg p-6 border border-outline">
    <h3 class="text-lg font-semibold text-content">{title}</h3>
    {description && <p class="text-content-light mt-2">{description}</p>}
    <slot />
</div>
```

## Using Components
```astro
---
import Card from '@/components/Card.astro';
---

<Card title="My Card" description="Optional description">
    <p>Slot content goes here</p>
</Card>
```

## Props with TypeScript
```astro
---
interface Props {
    variant?: 'primary' | 'secondary' | 'outline';
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
}

const {
    variant = 'primary',
    size = 'md',
    disabled = false
} = Astro.props;

const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg',
};
---

<button
    class:list={[
        'rounded-lg font-medium transition-colors cursor-pointer',
        sizeClasses[size],
        variant === 'primary' && 'bg-primary text-white hover:bg-primary-dark',
        variant === 'secondary' && 'bg-secondary text-white',
        variant === 'outline' && 'border border-outline text-content hover:bg-surface-alt',
        disabled && 'opacity-50 cursor-not-allowed',
    ]}
    disabled={disabled}
>
    <slot />
</button>
```

## Named Slots
```astro
---
// Layout with named slots
---
<header>
    <slot name="header" />
</header>
<main>
    <slot />
</main>
<footer>
    <slot name="footer" />
</footer>

<!-- Usage -->
<Layout>
    <h1 slot="header">Page Title</h1>
    <p>Main content</p>
    <p slot="footer">Footer content</p>
</Layout>
```
