# Icons Guide (Lucide)

Icons are pre-installed via the @lucide/astro package.

**IMPORTANT:** Always import icons individually for faster HMR. Never use barrel imports.

## Basic Usage
```astro
---
import ArrowRight from '@lucide/astro/icons/arrow-right';
import Mail from '@lucide/astro/icons/mail';
import Phone from '@lucide/astro/icons/phone';
---

<ArrowRight class="w-5 h-5" />
<Mail class="w-6 h-6 text-primary" />
<Phone class="w-4 h-4 text-content-light" />
```

## Import Pattern
```
import IconName from '@lucide/astro/icons/kebab-case-name';
```
Examples: arrow-right, shield-check, chart-column, message-circle, heart-handshake

## Common Icons
- Navigation: ArrowRight, ArrowLeft, ChevronDown, ChevronRight, Menu, X
- Actions: Plus, Minus, Edit, Trash, Save, Download, Upload, Share
- Communication: Mail, Phone, MessageCircle, Send
- Social: Github, Twitter, Facebook, Instagram, Linkedin
- Status: Check, CheckCircle, AlertCircle, AlertTriangle, Info
- UI: Search, Settings, User, Home, Star, Heart

## With Buttons
```astro
---
import ArrowRight from '@lucide/astro/icons/arrow-right';
---

<button class="bg-primary text-white px-4 py-2 rounded-lg flex items-center gap-2 cursor-pointer">
    Learn More
    <ArrowRight class="w-4 h-4" />
</button>
```
