import formsConfig from '@/config/forms.json';

export type FormProvider = 'none' | 'formspree' | 'web3forms' | 'wordpress';

export interface FormDelivery {
    /** Whether a backend is configured. When false, render a disabled submit. */
    enabled: boolean;
    provider: FormProvider;
    /** Where the <form> posts. '#' when not configured. */
    action: string;
    method: 'POST';
    /** Web3Forms access key, rendered as a hidden input when present. */
    accessKey: string;
}

const config = formsConfig as {
    provider?: string;
    formspreeId?: string;
    web3formsKey?: string;
    recipientEmail?: string;
};

export function getFormDelivery(): FormDelivery {
    const provider = (config.provider ?? 'none') as FormProvider;

    if (provider === 'formspree' && config.formspreeId) {
        return {
            enabled: true,
            provider,
            action: 'https://formspree.io/f/' + config.formspreeId,
            method: 'POST',
            accessKey: '',
        };
    }

    if (provider === 'web3forms' && config.web3formsKey) {
        return {
            enabled: true,
            provider,
            action: 'https://api.web3forms.com/submit',
            method: 'POST',
            accessKey: config.web3formsKey,
        };
    }

    if (provider === 'wordpress') {
        return {
            enabled: true,
            provider,
            action: '/api/contact',
            method: 'POST',
            accessKey: '',
        };
    }

    return { enabled: false, provider: 'none', action: '#', method: 'POST', accessKey: '' };
}
