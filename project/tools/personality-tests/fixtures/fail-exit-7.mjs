// 门禁自检用夹具：普通脚本，固定以非零码退出，用来证明「子进程非零 => 失败」。
process.stdout.write('fixture: deliberate non-zero exit\n');
process.exit(7);
