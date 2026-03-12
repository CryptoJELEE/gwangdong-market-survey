import { spawn } from 'node:child_process';

const commands = [
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['test']]
];

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

for (const [command, args] of commands) {
  console.log(`\n==> ${command} ${args.join(' ')}`);
  await runCommand(command, args);
}

console.log('\nVerification PASS');
