import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with OWASP's minimum recommended parameters (19 MiB, t=2, p=1).
 * Argon2id is the library default algorithm.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false; // malformed hash
    }
  }

  /**
   * Burns the same time as a real verification when the account does not exist,
   * so login response times do not reveal which emails are registered.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= hash('insightai-timing-equalizer', OPTIONS);
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
