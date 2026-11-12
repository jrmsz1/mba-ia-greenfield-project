import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { rootConfigModule, rootTypeOrmModule } from './app-roots';
import { AuthModule } from './auth/auth.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [rootConfigModule(), rootTypeOrmModule(), AuthModule, VideosModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
