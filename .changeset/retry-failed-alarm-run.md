---
'durability': patch
---

Retry a failed alarm run in memory before the fallback alarm. A run that failed on a transient storage fault used to leave all due work to the fallback alarm, `alarmMinDelayMs` away (15 s by default). A semaphore client whose claim report was due in that run then reported after the holder's grant window (10 s by default) had reclaimed the grant, and under sustained faults queued items could stop being admitted. The in-memory timer now retries after 1 s, doubling up to the fallback while runs keep failing; the fallback alarm is still armed.
