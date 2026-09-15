# sshj selects ciphers, key exchanges and key types reflectively through
# java.security providers, so R8 cannot see the classes it instantiates.
-keep class net.schmizz.sshj.** { *; }
-keep class com.hierynomus.** { *; }
-keep class org.bouncycastle.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
-dontwarn org.slf4j.**
-dontwarn org.bouncycastle.**
-dontwarn net.schmizz.sshj.**
