# Slurm

Running, waiting and finished jobs in three sections that collapse and resize like the ones in Files: live `squeue`, and recent `sacct` history with exit codes and memory, where jobs that failed, timed out or ran out of memory are marked in red. A fourth section at the bottom shows what the cluster has free and in use (CPUs, memory, GPUs and the jobs waiting, for the whole cluster and per partition). Click a job for its log viewer, which follows `stdout`/`stderr`; a job that hasn't finished opens on its details instead. Also cancel, submit (`sbatch`) from the editor, and a job-script template.

<Shot src="/screens/slurm.png" alt="The Slurm view with a running job, a pending job, a completed job, a job marked out of memory in red and a Cluster resources section" caption="Running, Waiting and Finished jobs are listed in their own sections, a job that ran out of memory is marked in red, and Cluster resources is at the bottom." width="1500" height="940" />

<Shot bare src="/screens/detail-slurm-resources.png" alt="Cluster resources for the whole cluster: 40 nodes, free CPU, memory and GPU bars, your jobs, and the standard partition" caption="Cluster resources shows free CPUs, memory and GPUs for the whole cluster, then each partition." width="324" height="158" />
