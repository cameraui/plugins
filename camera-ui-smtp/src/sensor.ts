import { MotionSensor } from '@camera.ui/sdk';

import type { JsonSchema } from '@camera.ui/sdk';

export interface SMTPSensorStorageValues {
  email: string;
  onText?: string;
  offText?: string;
}

export class SMTPMotionSensor extends MotionSensor<SMTPSensorStorageValues> {
  constructor() {
    super('SMTP Motion');
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'email',
        title: 'Email Address',
        format: 'email',
        description: 'The email address that triggers motion. The SMTP server accepts any username and domain.',
        placeholder: 'camera@camera.ui',
        store: true,
        required: true,
      },
      {
        type: 'string',
        key: 'onText',
        title: 'Motion On Text',
        description: 'Text pattern that triggers motion. Leave empty to trigger on any email.',
        placeholder: 'motion detected',
        store: true,
        required: false,
      },
      {
        type: 'string',
        key: 'offText',
        title: 'Motion Off Text',
        description: 'Text pattern that clears motion state.',
        placeholder: 'motion cleared',
        store: true,
        required: false,
      },
    ];
  }

  get email(): string {
    return this.storage.values.email;
  }

  get onText(): string | undefined {
    return this.storage.values.onText;
  }

  get offText(): string | undefined {
    return this.storage.values.offText;
  }
}
