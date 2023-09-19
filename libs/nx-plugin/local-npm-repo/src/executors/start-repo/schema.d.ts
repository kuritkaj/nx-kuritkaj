export interface StartRepoExecutorSchema {
  location: 'global' | 'user' | 'project' | 'none';
  storage?: string;
  port: number;
  config?: string;
  clear?: boolean;
}
